package simulation

import (
	"encoding/json"
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
)

type Package struct {
	ID          string       `json:"id"`
	Barcode     string       `json:"barcode"`
	Target      string       `json:"target"`
	Position    [3]float64   `json:"position"`
	Rotation    [3]float64   `json:"rotation"`
	Size        [3]float64   `json:"size"`
	Weight      float64      `json:"weight"`
	Color       string       `json:"color"`
	State       PackageState `json:"state"`
	TargetChute string       `json:"target_chute"`
	Speed       float64      `json:"speed"`
	Progress    float64      `json:"progress"`
	CreateTime  int64        `json:"create_time"`
}

type Simulation struct {
	redisClient   *redis.Client
	hub           *ws.Hub
	packages      map[string]*Package
	mu            sync.RWMutex
	conveyorSpeed float64
	running       bool
}

var regions = []string{"north", "east", "south", "southwest", "northwest"}
var regionNames = map[string]string{
	"north":     "华北",
	"east":      "华东",
	"south":     "华南",
	"southwest": "西南",
	"northwest": "西北",
}

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
	}
}

func (s *Simulation) Start() {
	s.running = true
	log.Println("Simulation started")

	go s.spawnPackages()
	go s.updateLoop()
	go s.broadcastLoop()
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
	barcode := fmt.Sprintf("SF%010d", rand.Int63n(9999999999))
	targetRegion := regions[rand.Intn(len(regions))]

	targetChute, ok := sorter.FindTargetChute(targetRegion)
	if !ok {
		return
	}

	pkg := &Package{
		ID:          uuid.New().String(),
		Barcode:     barcode,
		Target:      targetRegion,
		Position:    [3]float64{-12.0, 0.5, 0},
		Rotation:    [3]float64{0, 0, 0},
		Size:        [3]float64{0.6 + rand.Float64()*0.4, 0.3 + rand.Float64()*0.3, 0.4 + rand.Float64()*0.3},
		Weight:      1.0 + rand.Float64()*5.0,
		Color:       packageColors[rand.Intn(len(packageColors))],
		State:       StateEntering,
		TargetChute: targetChute.ID,
		Speed:       s.conveyorSpeed,
		Progress:    0.0,
		CreateTime:  time.Now().UnixNano() / int64(time.Millisecond),
	}

	s.mu.Lock()
	s.packages[pkg.ID] = pkg
	s.mu.Unlock()

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

	time.Sleep(200 * time.Millisecond)

	s.mu.Lock()
	if pkg, ok := s.packages[pkgID]; ok {
		pkg.State = StateMoving
	}
	s.mu.Unlock()
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

		s.updatePackages(delta)
	}
}

func (s *Simulation) updatePackages(delta float64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	conveyorLength := sorter.GetConveyorLength()
	startX := -conveyorLength / 2
	endX := conveyorLength / 2

	toRemove := []string{}

	for id, pkg := range s.packages {
		switch pkg.State {
		case StateEntering, StateScanning, StateMoving:
			pkg.Position[0] += pkg.Speed * delta
			pkg.Progress = (pkg.Position[0] - startX) / (endX - startX)

			if pkg.State == StateMoving {
				chute, ok := sorter.GetChute(pkg.TargetChute)
				if ok && chute.Status == sorter.ChuteStatusNormal {
					chuteX := sorter.ChuteIndexToPosition(chute.Index)
					if pkg.Position[0] >= chuteX-0.3 && pkg.Position[0] <= chuteX+0.3 {
						pkg.State = StateSorting
						go s.sortPackage(id)
					}
				} else if ok && chute.Status != sorter.ChuteStatusNormal {
					newChute, found := s.findAlternativeChute(chute.Index)
					if found {
						pkg.TargetChute = newChute.ID
						pkg.State = StateDiverted
					}
				}
			}

			if pkg.Position[0] > endX+2 {
				toRemove = append(toRemove, id)
			}

		case StateSorting:
			pkg.Position[2] -= 3.0 * delta
			pkg.Position[1] -= 1.0 * delta

			if pkg.Position[2] < -5 {
				toRemove = append(toRemove, id)
			}

		case StateDiverted:
			pkg.Position[0] += pkg.Speed * delta

			chute, ok := sorter.GetChute(pkg.TargetChute)
			if ok {
				chuteX := sorter.ChuteIndexToPosition(chute.Index)
				if pkg.Position[0] >= chuteX-0.3 && pkg.Position[0] <= chuteX+0.3 {
					pkg.State = StateSorting
					go s.sortPackage(id)
				}
			}

			if pkg.Position[0] > endX+2 {
				toRemove = append(toRemove, id)
			}
		}
	}

	for _, id := range toRemove {
		delete(s.packages, id)
	}
}

func (s *Simulation) findAlternativeChute(currentIndex int) (*sorter.Chute, bool) {
	allChutes := sorter.GetAllChutes()
	for i := currentIndex + 1; i < len(allChutes)+currentIndex; i++ {
		idx := i % len(allChutes)
		if chute, ok := sorter.GetChuteByIndex(idx); ok {
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
		pkg.State = StateDelivered
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

func (s *Simulation) SetConveyorSpeed(speed float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conveyorSpeed = speed

	for _, pkg := range s.packages {
		if pkg.State == StateMoving || pkg.State == StateEntering {
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
		sorter.SetChuteStatus(s.redisClient, chuteID, sorter.ChuteStatus(status))

		allChutes := sorter.GetAllChutes()
		s.hub.BroadcastMessage(ws.MsgTypeChuteStatus, allChutes)

	case "set_speed":
		if speed, ok := payloadMap["speed"].(float64); ok {
			s.SetConveyorSpeed(speed)
		}
	}
}

func (s *Simulation) GetSceneInitData() map[string]interface{} {
	return map[string]interface{}{
		"chutes":          sorter.GetAllChutes(),
		"conveyor_length": sorter.GetConveyorLength(),
		"conveyor_speed":  s.conveyorSpeed,
		"package_count":   len(s.packages),
	}
}

func GetPackagesJSON(pkgs []*Package) string {
	data, _ := json.Marshal(pkgs)
	return string(data)
}
