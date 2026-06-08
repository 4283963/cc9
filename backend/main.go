package main

import (
	"log"
	"net/http"
	"smart-logistics-digital-twin/pkg/simulation"
	"smart-logistics-digital-twin/pkg/sorter"
	"smart-logistics-digital-twin/pkg/ws"
)

func main() {
	redisClient := sorter.InitRedis()
	defer redisClient.Close()

	sorter.InitSortingTopology(redisClient)

	hub := ws.NewHub()

	sim := simulation.NewSimulation(redisClient, hub)

	hub.OnConnect = func(client *ws.Client) {
		initData := sim.GetSceneInitData()
		hub.SendToClient(client, ws.MsgTypeSceneInit, initData)
	}

	go hub.Run()
	go sim.Start()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws.ServeWsWithControl(hub, w, r, func(msg ws.Message) {
			sim.HandleControlMessage(msg)
		})
	})

	http.HandleFunc("/api/chute/status", func(w http.ResponseWriter, r *http.Request) {
		sorter.HandleChuteStatus(redisClient, w, r)
	})

	fs := http.FileServer(http.Dir("../frontend"))
	http.Handle("/", fs)

	log.Println("Server starting on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
