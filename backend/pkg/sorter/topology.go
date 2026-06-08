package sorter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
)

var ctx = context.Background()

const (
	topologyLockKey     = "topology:write_lock"
	topologyLockTimeout = 5 * time.Second
	chuteKeyPrefix      = "chute:"
)

type ChuteStatus string

const (
	ChuteStatusNormal      ChuteStatus = "normal"
	ChuteStatusFault       ChuteStatus = "fault"
	ChuteStatusMaintenance ChuteStatus = "maintenance"
)

type Chute struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	Position [3]float64  `json:"position"`
	Status   ChuteStatus `json:"status"`
	Target   string      `json:"target"`
	Index    int         `json:"index"`
	Version  int64       `json:"version"`
}

type SortingTopology struct {
	Chutes         map[string]*Chute `json:"chutes"`
	ConveyorLength float64           `json:"conveyor_length"`
	Version        int64             `json:"version"`
	mu             sync.RWMutex
}

var topology *SortingTopology
var redisClient *redis.Client

func InitRedis() *redis.Client {
	rdb := redis.NewClient(&redis.Options{
		Addr:     "localhost:6379",
		Password: "",
		DB:       0,
	})

	_, err := rdb.Ping(ctx).Result()
	if err != nil {
		log.Printf("Warning: Redis connection failed, using in-memory fallback: %v", err)
	}

	redisClient = rdb
	return rdb
}

func acquireTopologyLock() (bool, string) {
	if redisClient == nil {
		return true, ""
	}

	lockValue := fmt.Sprintf("lock_%d", time.Now().UnixNano())
	ok, err := redisClient.SetNX(ctx, topologyLockKey, lockValue, topologyLockTimeout).Result()
	if err != nil {
		log.Printf("Redis lock error: %v", err)
		return true, lockValue
	}
	return ok, lockValue
}

func releaseTopologyLock(lockValue string) {
	if redisClient == nil || lockValue == "" {
		return
	}

	current, err := redisClient.Get(ctx, topologyLockKey).Result()
	if err == nil && current == lockValue {
		redisClient.Del(ctx, topologyLockKey)
	}
}

func InitSortingTopology(rdb *redis.Client) {
	topology = &SortingTopology{
		Chutes:         make(map[string]*Chute),
		ConveyorLength: 20.0,
		Version:        1,
	}

	chutes := []*Chute{
		{ID: "chute-001", Name: "华北分拨口", Position: [3]float64{-8, 0, -3}, Status: ChuteStatusNormal, Target: "north", Index: 0, Version: 1},
		{ID: "chute-002", Name: "华东分拨口", Position: [3]float64{-4, 0, -3}, Status: ChuteStatusNormal, Target: "east", Index: 1, Version: 1},
		{ID: "chute-003", Name: "华南分拨口", Position: [3]float64{0, 0, -3}, Status: ChuteStatusNormal, Target: "south", Index: 2, Version: 1},
		{ID: "chute-004", Name: "西南分拨口", Position: [3]float64{4, 0, -3}, Status: ChuteStatusNormal, Target: "southwest", Index: 3, Version: 1},
		{ID: "chute-005", Name: "西北分拨口", Position: [3]float64{8, 0, -3}, Status: ChuteStatusNormal, Target: "northwest", Index: 4, Version: 1},
	}

	locked, lockVal := acquireTopologyLock()
	if !locked {
		log.Println("Warning: could not acquire topology lock for init")
	}
	defer releaseTopologyLock(lockVal)

	for _, chute := range chutes {
		topology.Chutes[chute.ID] = chute

		if rdb != nil {
			key := fmt.Sprintf("%s%s", chuteKeyPrefix, chute.ID)
			data, _ := json.Marshal(chute)
			rdb.Set(ctx, key, data, 0)
		}
	}

	if rdb != nil {
		rdb.Set(ctx, "topology:chute_count", len(chutes), 0)
		rdb.Set(ctx, "topology:version", topology.Version, 0)
	}

	log.Println("Sorting topology initialized with", len(chutes), "chutes")
}

func GetTopology() *SortingTopology {
	return topology
}

func GetTopologyVersion() int64 {
	topology.mu.RLock()
	defer topology.mu.RUnlock()
	return topology.Version
}

func GetChute(id string) (*Chute, bool) {
	topology.mu.RLock()
	defer topology.mu.RUnlock()
	chute, ok := topology.Chutes[id]
	if !ok {
		return nil, false
	}
	chuteCopy := *chute
	return &chuteCopy, true
}

func SetChuteStatus(rdb *redis.Client, chuteID string, status ChuteStatus) error {
	locked, lockVal := acquireTopologyLock()
	if !locked {
		return errors.New("topology is busy, please retry")
	}
	defer releaseTopologyLock(lockVal)

	topology.mu.Lock()
	defer topology.mu.Unlock()

	chute, ok := topology.Chutes[chuteID]
	if !ok {
		return fmt.Errorf("chute %s not found", chuteID)
	}

	if chute.Status == status {
		log.Printf("Chute %s already in status %s, no change", chuteID, status)
		return nil
	}

	chute.Status = status
	chute.Version++
	topology.Version++

	if rdb != nil {
		key := fmt.Sprintf("%s%s", chuteKeyPrefix, chuteID)
		data, _ := json.Marshal(chute)
		pipe := rdb.TxPipeline()
		pipe.Set(ctx, key, data, 0)
		pipe.Set(ctx, "topology:version", topology.Version, 0)
		_, err := pipe.Exec(ctx)
		if err != nil {
			log.Printf("Redis update error: %v", err)
		}
	}

	log.Printf("Chute %s status updated to %s (v%d)", chuteID, status, chute.Version)
	return nil
}

func SetChuteStatusWithRetry(rdb *redis.Client, chuteID string, status ChuteStatus, maxRetries int) error {
	for i := 0; i < maxRetries; i++ {
		err := SetChuteStatus(rdb, chuteID, status)
		if err == nil {
			return nil
		}
		if i < maxRetries-1 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	return fmt.Errorf("failed to set chute status after %d retries", maxRetries)
}

func GetAvailableChutes() []*Chute {
	topology.mu.RLock()
	defer topology.mu.RUnlock()

	var available []*Chute
	for _, chute := range topology.Chutes {
		if chute.Status == ChuteStatusNormal {
			chuteCopy := *chute
			available = append(available, &chuteCopy)
		}
	}
	return available
}

func FindTargetChute(targetRegion string) (*Chute, bool) {
	topology.mu.RLock()
	defer topology.mu.RUnlock()

	for _, chute := range topology.Chutes {
		if chute.Target == targetRegion && chute.Status == ChuteStatusNormal {
			chuteCopy := *chute
			return &chuteCopy, true
		}
	}

	for _, chute := range topology.Chutes {
		if chute.Status == ChuteStatusNormal {
			chuteCopy := *chute
			return &chuteCopy, true
		}
	}

	return nil, false
}

func FindNextAvailableChute(fromIndex int) (*Chute, bool) {
	topology.mu.RLock()
	defer topology.mu.RUnlock()

	chuteCount := len(topology.Chutes)
	for i := fromIndex + 1; i < chuteCount; i++ {
		if chute, ok := topology.Chutes[fmt.Sprintf("chute-%03d", i+1)]; ok {
			if chute.Status == ChuteStatusNormal {
				chuteCopy := *chute
				return &chuteCopy, true
			}
		}
	}

	for i := 0; i < chuteCount; i++ {
		if chute, ok := topology.Chutes[fmt.Sprintf("chute-%03d", i+1)]; ok {
			if chute.Status == ChuteStatusNormal {
				chuteCopy := *chute
				return &chuteCopy, true
			}
		}
	}

	return nil, false
}

func GetAllChutes() []*Chute {
	topology.mu.RLock()
	defer topology.mu.RUnlock()

	chutes := make([]*Chute, 0, len(topology.Chutes))
	for _, chute := range topology.Chutes {
		chuteCopy := *chute
		chutes = append(chutes, &chuteCopy)
	}
	return chutes
}

func GetChutesSortedByIndex() []*Chute {
	all := GetAllChutes()

	sorted := make([]*Chute, len(all))
	count := 0
	for _, c := range all {
		if c.Index >= 0 && c.Index < len(sorted) {
			sorted[c.Index] = c
			count++
		}
	}

	result := make([]*Chute, 0, count)
	for _, c := range sorted {
		if c != nil {
			result = append(result, c)
		}
	}
	return result
}

func HandleChuteStatus(rdb *redis.Client, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	switch r.Method {
	case http.MethodGet:
		chuteID := r.URL.Query().Get("id")
		if chuteID != "" {
			chute, ok := GetChute(chuteID)
			if !ok {
				http.Error(w, "Chute not found", http.StatusNotFound)
				return
			}
			json.NewEncoder(w).Encode(chute)
		} else {
			json.NewEncoder(w).Encode(GetAllChutes())
		}

	case http.MethodPost:
		var req struct {
			ID     string      `json:"id"`
			Status ChuteStatus `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if err := SetChuteStatusWithRetry(rdb, req.ID, req.Status, 3); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}

		chute, _ := GetChute(req.ID)
		json.NewEncoder(w).Encode(chute)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func GetChuteCount() int {
	topology.mu.RLock()
	defer topology.mu.RUnlock()
	return len(topology.Chutes)
}

func GetConveyorLength() float64 {
	return topology.ConveyorLength
}

func ChuteIndexToPosition(index int) float64 {
	count := GetChuteCount()
	if count <= 1 {
		return 0
	}
	length := GetConveyorLength()
	startX := -length / 2
	spacing := length / float64(count-1)
	return startX + float64(index)*spacing
}

func GetChuteByIndex(index int) (*Chute, bool) {
	topology.mu.RLock()
	defer topology.mu.RUnlock()

	for _, c := range topology.Chutes {
		if c.Index == index {
			chuteCopy := *c
			return &chuteCopy, true
		}
	}
	return nil, false
}

func StrToInt(s string, def int) int {
	if v, err := strconv.Atoi(s); err == nil {
		return v
	}
	return def
}
