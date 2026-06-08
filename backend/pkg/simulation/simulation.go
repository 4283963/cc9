package simulation

import (
	"fmt"
	"log"
	"math/rand"
	"sync"
	"time"

	"smart-logistics-digital-twin/pkg/sorter"
	"smart-logistics-digital-twin/pkg/ws"

	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
)

type PackageState string

const (
	StateEntering  PackageState = "entering"
	StateScanning  PackageState = "scanning"
	StateMoving    PackageState = "moving"
	StateSorting   PackageState = "sorting"
	StateDelivered PackageState = "delivered"
	StateDiverted  PackageState = "diverted"
	StateExiting   PackageState = "exiting"
	StateError     PackageState = "error"
	StateOversized PackageState = "oversized"
)

const (
	maxPackageLifetime = 30 * time.Second
	packageMaxXOffset  = 3.0

	maxChuteWidth  = 1.0
	maxChuteHeight = 0.6
	maxChuteDepth  = 0.8
)

type Package struct {
	ID             string       `json:"id"`
	Barcode        string       `json:"barcode"`
	Target         string       `json:"target"`
	Position       [3]float64   `json:"position"`
	Rotation       [3]float64   `json:"rotation"`
	Size           [3]float64   `json:"size"`
	Weight         float64      `json:"weight"`
	Color          string       `json:"color"`
	State          PackageState `json:"state"`
	TargetChute    string       `json:"target_chute"`
	TargetChuteIdx int          `json:"target_chute_idx"`
	Speed          float64      `json:"speed"`
	Progress       float64      `json:"progress"`
	CreateTime     int64        `json:"create_time"`
	RetryCount     int          `json:"retry_count"`
	LastTopoVer    int64        `json:"-"`
	IsOversized    bool         `json:"is_oversized"`
	OversizeReason string       `json:"oversize_reason,omitempty"`
}

type FunnelStats struct {
	TotalEntered     int64   `json:"total_entered"`
	Scanned          int64   `json:"scanned"`
	OversizedBlocked int64   `json:"oversized_blocked"`
	Sorting          int64   `json:"sorting"`
	Delivered        int64   `json:"delivered"`
	Failed           int64   `json:"failed"`
	InterceptRate    float64 `json:"intercept_rate"`
	SuccessRate      float64 `json:"success_rate"`
	ErrorRate        float64 `json:"error_rate"`
}

type Simulation struct {
	redisClient   *redis.Client
	hub           *ws.Hub
	packages      map[string]*Package
	mu            sync.RWMutex
	conveyorSpeed float64
	running       bool
	lastTopoVer   int64

	funnel      FunnelStats
	funnelMu    sync.RWMutex
	windowStart time.Time
}

var regions = []string{"north", "east", "south", "southwest", "northwest"}

var packageColors = []string{
	"#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
	"#1abc9c", "#e67e22", "#34495e",
}

func NewSimulation(rdb *redis.Client, hub *ws.Hub) *Simulation {
	return &Simulation{
		redisClient:   rdb,
		hub:           hub,
		packages:      make(map[string]*Package),
		conveyorSpeed: 2.0,
		running:       false,
		lastTopoVer:   1,
		windowStart:   time.Now(),
	}
}

func (s *Simulation) Start() {
	s.running = true
	s.lastTopoVer = sorter.GetTopologyVersion()
	s.windowStart = time.Now()
	log.Println("Simulation started")

	go s.spawnPackages()
	go s.updateLoop()
	go s.broadcastLoop()
	go s.funnelBroadcastLoop()
}

func (s *Simulation) Stop() {
	s.running = false
}

func (s *Simulation) spawnPackages() {
	ticker := time.NewTicker(800 * time.Millisecond)
	defer ticker.Stop()

	for s.running {
		<-ticker.C
		s.spawnPackage()
	}
}

func (s *Simulation) spawnPackage() {
	targetRegion := regions[rand.Intn(len(regions))]

	targetChute, ok := sorter.FindTargetChute(targetRegion)
	if !ok {
		return
	}

	barcode := fmt.Sprintf("SF%010d", rand.Int63n(9999999999))

	width := 0.5 + rand.Float64()*0.5
	height := 0.25 + rand.Float64()*0.45
	depth := 0.35 + rand.Float64()*0.55

	pkg := &Package{
		ID:             uuid.New().String(),
		Barcode:        barcode,
		Target:         targetRegion,
		Position:       [3]float64{-12.0, 0.5, 0},
		Rotation:       [3]float64{0, 0, 0},
		Size:           [3]float64{width, height, depth},
		Weight:         1.0 + rand.Float64()*8.0,
		Color:          packageColors[rand.Intn(len(packageColors))],
		State:          StateEntering,
		TargetChute:    targetChute.ID,
		TargetChuteIdx: targetChute.Index,
		Speed:          s.conveyorSpeed,
		Progress:       0.0,
		CreateTime:     time.Now().UnixNano() / int64(time.Millisecond),
		RetryCount:     0,
		LastTopoVer:    s.lastTopoVer,
		IsOversized:    false,
	}

	s.mu.Lock()
	s.packages[pkg.ID] = pkg
	s.mu.Unlock()

	s.funnelMu.Lock()
	s.funnel.TotalEntered++
	s.recalcRates()
	s.funnelMu.Unlock()

	go s.scanPackage(pkg.ID)
}

func (s *Simulation) scanPackage(pkgID string) {
	time.Sleep(300 * time.Millisecond)

	s.mu.Lock()
	pkg, ok := s.packages[pkgID]
	if ok {
		pkg.State = StateScanning
	}
	s.mu.Unlock()

	s.funnelMu.Lock()
	s.funnel.Scanned++
	s.recalcRates()
	s.funnelMu.Unlock()

	time.Sleep(200 * time.Millisecond)

	s.mu.Lock()
	if pkg, ok := s.packages[pkgID]; ok {
		oversized, reason := checkOversized(pkg)
		if oversized {
			pkg.State = StateOversized
			pkg.IsOversized = true
			pkg.OversizeReason = reason

			s.funnelMu.Lock()
			s.funnel.OversizedBlocked++
			s.funnel.Failed++
			s.recalcRates()
			s.funnelMu.Unlock()

			log.Printf("Package %s blocked: %s (%.2f x %.2f x %.2f)",
				pkgID, reason, pkg.Size[0], pkg.Size[1], pkg.Size[2])
		} else {
			pkg.State = StateMoving
		}
	}
	s.mu.Unlock()
}

func checkOversized(pkg *Package) (bool, string) {
	if pkg.Size[0] > maxChuteWidth {
		return true, fmt.Sprintf("宽度超标 %.2f > %.2f m", pkg.Size[0], maxChuteWidth)
	}
	if pkg.Size[1] > maxChuteHeight {
		return true, fmt.Sprintf("高度超标 %.2f > %.2f m", pkg.Size[1], maxChuteHeight)
	}
	if pkg.Size[2] > maxChuteDepth {
		return true, fmt.Sprintf("深度超标 %.2f > %.2f m", pkg.Size[2], maxChuteDepth)
	}
	volume := pkg.Size[0] * pkg.Size[1] * pkg.Size[2]
	maxVolume := maxChuteWidth * maxChuteHeight * maxChuteDepth
	if volume > maxVolume {
		return true, fmt.Sprintf("体积超标 %.3f > %.3f m³", volume, maxVolume)
	}
	return false, ""
}

func (s *Simulation) recalcRates() {
	if s.funnel.TotalEntered == 0 {
		s.funnel.InterceptRate = 0
		s.funnel.SuccessRate = 0
		s.funnel.ErrorRate = 0
		return
	}
	s.funnel.InterceptRate = float64(s.funnel.OversizedBlocked) / float64(s.funnel.TotalEntered) * 100
	s.funnel.SuccessRate = float64(s.funnel.Delivered) / float64(s.funnel.TotalEntered) * 100
	s.funnel.ErrorRate = float64(s.funnel.Failed) / float64(s.funnel.TotalEntered) * 100
}

func (s *Simulation) updateLoop() {
	ticker := time.NewTicker(16 * time.Millisecond)
	defer ticker.Stop()

	lastTime := time.Now()

	for s.running {
		<-ticker.C
		now := time.Now()
		delta := now.Sub(lastTime).Seconds()
		lastTime = now

		s.checkTopologyChange()
		s.updatePackages(delta, now)
	}
}

func (s *Simulation) checkTopologyChange() {
	currentVer := sorter.GetTopologyVersion()
	if currentVer != s.lastTopoVer {
		log.Printf("Topology changed: v%d -> v%d, re-validating package targets", s.lastTopoVer, currentVer)
		s.lastTopoVer = currentVer
	}
}

func (s *Simulation) updatePackages(delta float64, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()

	conveyorLength := sorter.GetConveyorLength()
	startX := -conveyorLength / 2
	endX := conveyorLength / 2
	nowMs := now.UnixNano() / int64(time.Millisecond)

	toRemove := []string{}

	for id, pkg := range s.packages {
		age := time.Duration(nowMs-pkg.CreateTime) * time.Millisecond
		if age > maxPackageLifetime {
			toRemove = append(toRemove, id)
			continue
		}

		if pkg.LastTopoVer != s.lastTopoVer && pkg.State != StateOversized {
			s.validatePackageTarget(pkg)
			pkg.LastTopoVer = s.lastTopoVer
		}

		switch pkg.State {
		case StateEntering, StateScanning:
			pkg.Position[0] += pkg.Speed * delta
			pkg.Progress = (pkg.Position[0] - startX) / (endX - startX)

			if pkg.Position[0] > endX+packageMaxXOffset {
				pkg.State = StateExiting
				toRemove = append(toRemove, id)
			}

		case StateOversized:
			pkg.Position[0] += pkg.Speed * delta * 0.3

			if pkg.Position[0] > endX+packageMaxXOffset+2 {
				toRemove = append(toRemove, id)
			}

		case StateMoving:
			pkg.Position[0] += pkg.Speed * delta
			pkg.Progress = (pkg.Position[0] - startX) / (endX - startX)
			s.handleMovingState(pkg)

			if pkg.Position[0] > endX+packageMaxXOffset {
				pkg.State = StateExiting
				toRemove = append(toRemove, id)
			}

		case StateDiverted:
			pkg.Position[0] += pkg.Speed * delta
			s.handleDivertedState(pkg)

			if pkg.Position[0] > endX+packageMaxXOffset {
				pkg.State = StateExiting
				toRemove = append(toRemove, id)
			}

		case StateSorting:
			pkg.Position[2] -= 3.0 * delta
			pkg.Position[1] -= 1.0 * delta

			if pkg.Position[2] < -5 || pkg.Position[1] < -1 {
				pkg.State = StateDelivered
				s.funnelMu.Lock()
				s.funnel.Delivered++
				s.recalcRates()
				s.funnelMu.Unlock()
				toRemove = append(toRemove, id)
			}

		case StateDelivered, StateExiting, StateError:
			if pkg.State == StateError {
				s.funnelMu.Lock()
				s.funnel.Failed++
				s.recalcRates()
				s.funnelMu.Unlock()
			}
			toRemove = append(toRemove, id)
		}
	}

	for _, id := range toRemove {
		delete(s.packages, id)
	}
}

func (s *Simulation) validatePackageTarget(pkg *Package) {
	if pkg.State != StateMoving && pkg.State != StateDiverted {
		return
	}

	chute, ok := sorter.GetChute(pkg.TargetChute)
	if !ok {
		s.routeToNextAvailable(pkg)
		return
	}

	if chute.Status != sorter.ChuteStatusNormal {
		log.Printf("Package %s target chute %s is %s, rerouting", pkg.ID, chute.ID, chute.Status)
		s.routeToNextAvailable(pkg)
	} else {
		pkg.TargetChuteIdx = chute.Index
	}
}

func (s *Simulation) handleMovingState(pkg *Package) {
	chute, ok := sorter.GetChute(pkg.TargetChute)
	if !ok {
		s.routeToNextAvailable(pkg)
		return
	}

	if chute.Status != sorter.ChuteStatusNormal {
		pkg.RetryCount++
		if pkg.RetryCount > 10 {
			pkg.State = StateError
			log.Printf("Package %s exceeded retry limit, marking as error", pkg.ID)
			return
		}
		s.routeToNextAvailable(pkg)
		return
	}

	chuteX := sorter.ChuteIndexToPosition(chute.Index)

	if pkg.Position[0] >= chuteX-0.3 && pkg.Position[0] <= chuteX+0.3 {
		pkg.State = StateSorting
		s.funnelMu.Lock()
		s.funnel.Sorting++
		s.recalcRates()
		s.funnelMu.Unlock()
		go s.sortPackage(pkg.ID)
	}
}

func (s *Simulation) handleDivertedState(pkg *Package) {
	chute, ok := sorter.GetChute(pkg.TargetChute)
	if !ok {
		s.routeToNextAvailable(pkg)
		return
	}

	if chute.Status != sorter.ChuteStatusNormal {
		pkg.RetryCount++
		if pkg.RetryCount > 10 {
			pkg.State = StateError
			log.Printf("Package %s exceeded retry limit during diversion", pkg.ID)
			return
		}
		s.routeToNextAvailable(pkg)
		return
	}

	chuteX := sorter.ChuteIndexToPosition(chute.Index)

	if pkg.Position[0] >= chuteX-0.3 && pkg.Position[0] <= chuteX+0.3 {
		pkg.State = StateSorting
		s.funnelMu.Lock()
		s.funnel.Sorting++
		s.recalcRates()
		s.funnelMu.Unlock()
		go s.sortPackage(pkg.ID)
	}
}

func (s *Simulation) routeToNextAvailable(pkg *Package) {
	currentIdx := pkg.TargetChuteIdx

	nextChute, found := findNextAvailableChuteForward(currentIdx)
	if !found {
		for i := 0; i <= currentIdx; i++ {
			if c, ok := sorter.GetChuteByIndex(i); ok {
				if c.Status == sorter.ChuteStatusNormal {
					nextChute = c
					found = true
					break
				}
			}
		}

		if !found {
			log.Printf("Warning: no available chutes for package %s", pkg.ID)
			pkg.State = StateError
			return
		}
	}

	if found && nextChute != nil {
		pkg.TargetChute = nextChute.ID
		pkg.TargetChuteIdx = nextChute.Index

		chuteX := sorter.ChuteIndexToPosition(nextChute.Index)
		if pkg.Position[0] >= chuteX {
			pkg.State = StateError
			log.Printf("Package %s cannot reach chute %s (already passed)", pkg.ID, nextChute.ID)
			return
		}

		pkg.State = StateDiverted
	}
}

func findNextAvailableChuteForward(fromIndex int) (*sorter.Chute, bool) {
	count := sorter.GetChuteCount()
	for i := fromIndex + 1; i < count; i++ {
		if chute, ok := sorter.GetChuteByIndex(i); ok {
			if chute.Status == sorter.ChuteStatusNormal {
				return chute, true
			}
		}
	}
	return nil, false
}

func (s *Simulation) sortPackage(pkgID string) {
	time.Sleep(500 * time.Millisecond)
	s.mu.Lock()
	if pkg, ok := s.packages[pkgID]; ok {
		if pkg.State == StateSorting {
			pkg.State = StateDelivered
		}
	}
	s.mu.Unlock()
}

func (s *Simulation) broadcastLoop() {
	ticker := time.NewTicker(33 * time.Millisecond)
	defer ticker.Stop()

	for s.running {
		<-ticker.C
		s.broadcastPackages()
	}
}

func (s *Simulation) broadcastPackages() {
	s.mu.RLock()

	pkgList := make([]*Package, 0, len(s.packages))
	for _, pkg := range s.packages {
		pkgList = append(pkgList, pkg)
	}

	s.mu.RUnlock()

	s.hub.BroadcastMessage(ws.MsgTypePackageUpdate, pkgList)
}

func (s *Simulation) funnelBroadcastLoop() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for s.running {
		<-ticker.C
		s.broadcastFunnel()
	}
}

func (s *Simulation) broadcastFunnel() {
	s.funnelMu.RLock()
	stats := s.funnel
	elapsed := time.Since(s.windowStart).Seconds()
	s.funnelMu.RUnlock()

	funnelData := map[string]interface{}{
		"total_entered":     stats.TotalEntered,
		"scanned":           stats.Scanned,
		"oversized_blocked": stats.OversizedBlocked,
		"sorting":           stats.Sorting,
		"delivered":         stats.Delivered,
		"failed":            stats.Failed,
		"intercept_rate":    stats.InterceptRate,
		"success_rate":      stats.SuccessRate,
		"error_rate":        stats.ErrorRate,
		"throughput":        float64(stats.TotalEntered) / elapsed,
		"window_seconds":    elapsed,
		"max_chute_width":   maxChuteWidth,
		"max_chute_height":  maxChuteHeight,
		"max_chute_depth":   maxChuteDepth,
	}

	s.hub.BroadcastMessage("funnel_stats", funnelData)
}

func (s *Simulation) SetConveyorSpeed(speed float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conveyorSpeed = speed

	for _, pkg := range s.packages {
		if pkg.State == StateMoving || pkg.State == StateEntering || pkg.State == StateDiverted {
			pkg.Speed = speed
		}
	}

	s.hub.BroadcastMessage(ws.MsgTypeConveyorSpeed, map[string]float64{"speed": speed})
}

func (s *Simulation) HandleControlMessage(msg ws.Message) {
	payloadMap, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}

	action, _ := payloadMap["action"].(string)

	switch action {
	case "set_chute_status":
		chuteID, _ := payloadMap["chute_id"].(string)
		status, _ := payloadMap["status"].(string)

		log.Printf("Control: set chute %s status to %s", chuteID, status)

		err := sorter.SetChuteStatusWithRetry(s.redisClient, chuteID, sorter.ChuteStatus(status), 3)
		if err != nil {
			log.Printf("Failed to set chute status: %v", err)
			return
		}

		s.lastTopoVer = sorter.GetTopologyVersion()

		allChutes := sorter.GetAllChutes()
		s.hub.BroadcastMessage(ws.MsgTypeChuteStatus, allChutes)

	case "set_speed":
		if speed, ok := payloadMap["speed"].(float64); ok {
			s.SetConveyorSpeed(speed)
		}

	case "reset_stats":
		s.funnelMu.Lock()
		s.funnel = FunnelStats{}
		s.windowStart = time.Now()
		s.funnelMu.Unlock()
		log.Println("Funnel statistics reset")
	}
}

func (s *Simulation) GetSceneInitData() map[string]interface{} {
	s.mu.RLock()
	pkgCount := len(s.packages)
	s.mu.RUnlock()

	s.funnelMu.RLock()
	stats := s.funnel
	s.funnelMu.RUnlock()

	return map[string]interface{}{
		"chutes":           sorter.GetAllChutes(),
		"conveyor_length":  sorter.GetConveyorLength(),
		"conveyor_speed":   s.conveyorSpeed,
		"package_count":    pkgCount,
		"topology_version": s.lastTopoVer,
		"funnel_stats":     stats,
		"chute_limits": map[string]float64{
			"width":  maxChuteWidth,
			"height": maxChuteHeight,
			"depth":  maxChuteDepth,
		},
	}
}
