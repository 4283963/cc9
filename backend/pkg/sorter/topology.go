package sorter

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"

	"github.com/go-redis/redis/v8"
)

var ctx = context.Background()

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
}

type SortingTopology struct {
	Chutes         map[string]*Chute `json:"chutes"`
	ConveyorLength float64           `json:"conveyor_length"`
	mu             sync.RWMutex
}

var topology *SortingTopology

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

	return rdb
}

func InitSortingTopology(rdb *redis.Client) {
	topology = &SortingTopology{
		Chutes:         make(map[string]*Chute),
		ConveyorLength: 20.0,
	}

	chutes := []*Chute{
		{ID: "chute-001", Name: "华北分拨口", Position: [3]float64{-8, 0, -3}, Status: ChuteStatusNormal, Target: "north", Index: 0},
		{ID: "chute-002", Name: "华东分拨口", Position: [3]float64{-4, 0, -3}, Status: ChuteStatusNormal, Target: "east", Index: 1},
		{ID: "chute-003", Name: "华南分拨口", Position: [3]float64{0, 0, -3}, Status: ChuteStatusNormal, Target: "south", Index: 2},
		{ID: "chute-004", Name: "西南分拨口", Position: [3]float64{4, 0, -3}, Status: ChuteStatusNormal, Target: "southwest", Index: 3},
		{ID: "chute-005", Name: "西北分拨口", Position: [3]float64{8, 0, -3}, Status: ChuteStatusNormal, Target: "northwest", Index: 4},
	}

	for _, chute := range chutes {
		topology.Chutes[chute.ID] = chute

		key := fmt.Sprintf("chute:%s", chute.ID)
		data, _ := json.Marshal(chute)
		rdb.Set(ctx, key, data, 0)
	}

	rdb.Set(ctx, "topology:chute_count", len(chutes), 0)

	log.Println("Sorting topology initialized with", len(chutes), "chutes")
}

func GetTopology() *SortingTopology {
	return topology
}

func GetChute(id string) (*Chute, bool) {
	topology.mu.RLock()
	defer topology.mu.RUnlock()
	chute, ok := topology.Chutes[id]
	return chute, ok
}

func SetChuteStatus(rdb *redis.Client, chuteID string, status ChuteStatus) error {
	topology.mu.Lock()
	defer topology.mu.Unlock()

	chute, ok := topology.Chutes[chuteID]
	if !ok {
		return fmt.Errorf("chute %s not found", chuteID)
	}

	chute.Status = status

	key := fmt.Sprintf("chute:%s", chuteID)
	data, _ := json.Marshal(chute)
	rdb.Set(ctx, key, data, 0)

	log.Printf("Chute %s status updated to %s", chuteID, status)
	return nil
}

func GetAvailableChutes() []*Chute {
	topology.mu.RLock()
	defer topology.mu.RUnlock()

	var available []*Chute
	for _, chute := range topology.Chutes {
		if chute.Status == ChuteStatusNormal {
			available = append(available, chute)
		}
	}
	return available
}

func FindTargetChute(targetRegion string) (*Chute, bool) {
	topology.mu.RLock()
	defer topology.mu.RUnlock()

	for _, chute := range topology.Chutes {
		if chute.Target == targetRegion && chute.Status == ChuteStatusNormal {
			return chute, true
		}
	}

	for _, chute := range topology.Chutes {
		if chute.Status == ChuteStatusNormal {
			return chute, true
		}
	}

	return nil, false
}

func GetAllChutes() []*Chute {
	topology.mu.RLock()
	defer topology.mu.RUnlock()

	chutes := make([]*Chute, 0, len(topology.Chutes))
	for _, chute := range topology.Chutes {
		chutes = append(chutes, chute)
	}
	return chutes
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

		if err := SetChuteStatus(rdb, req.ID, req.Status); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}

		chute, _ := GetChute(req.ID)
		json.NewEncoder(w).Encode(chute)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func GetChuteCount() int {
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
	chutes := GetAllChutes()
	for _, c := range chutes {
		if c.Index == index {
			return c, true
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
