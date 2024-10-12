import grpc
from concurrent import futures
import time
import threading
from flask import Flask, jsonify, request
from pymongo import MongoClient
import sports_service_pb2
import sports_service_pb2_grpc

app = Flask(__name__)

# MongoDB connection setup
client = MongoClient('mongodb://mongo:27017/')
db = client['sports_database']

CRITICAL_LOAD_THRESHOLD = 10

class SportsService(sports_service_pb2_grpc.SportsServiceServicer):
    def __init__(self):
        self.load_counter = 0
        self.start_time = time.time()

    def Ping(self, request, context):
        current_time = time.time()
        elapsed_time = current_time - self.start_time

        if elapsed_time >= 1.0:
            if self.load_counter >= CRITICAL_LOAD_THRESHOLD:
                print(f"ALERT: Load threshold exceeded! {self.load_counter} pings in the last second.")
            else:
                print(f"INFO: Load below threshold: {self.load_counter} pings in the last second.")
                
            self.load_counter = 0
            self.start_time = current_time

        self.load_counter += 1
        print(f"Ping received: {request.message}. Current load: {self.load_counter}")

        response_message = f"Ping received: {request.message}, current load: {self.load_counter}"
        return sports_service_pb2.PingResponse(response=response_message, load=self.load_counter)

# Start gRPC server
def serve_grpc():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    sports_service_pb2_grpc.add_SportsServiceServicer_to_server(SportsService(), server)
    server.add_insecure_port('[::]:50051')
    print("Starting gRPC SportsService on port 50051...")
    server.start()
    server.wait_for_termination()

# Status Endpoint
@app.route('/status', methods=['GET'])
def status():
    return jsonify({"status": "Sports Management Service is running"}), 200

# Get ongoing sports events
@app.route('/api/sports/ongoing-events', methods=['GET'])
def get_ongoing_events():
    events = list(db.events.find({"event_status": "ongoing"}))
    events_data = [{"sport_category": event['sport_category'], "team_1": event['team_1'], 
                    "team_2": event['team_2'], "score_team_1": event['score_team_1'], 
                    "score_team_2": event['score_team_2']} for event in events]
    return jsonify({"status": "success", "data": events_data}), 200

# Add a new sports event
@app.route('/api/sports/events', methods=['POST'])
def add_event():
    event_data = request.get_json()

    if 'event_id' not in event_data:
        return jsonify({"status": "error", "message": "event_id is required"}), 400
    
    db.events.insert_one(event_data)

    return jsonify({"status": "success", "message": "Event added", "event_id": event_data['event_id']}), 201

# Get sports categories
@app.route('/api/sports/categories', methods=['GET'])
def get_sports_categories():
    categories = list(db.categories.find())
    categories_data = [{"category_id": category["category_id"], "category_name": category["category_name"]} for category in categories]
    return jsonify({"status": "success", "data": categories_data}), 200

# Get details for a specific game
@app.route('/api/sports/games/<string:game_id>', methods=['GET'])
def get_game_details(game_id):
    game = db.events.find_one({"event_id": game_id})
    if game:
        return jsonify({
            "status": "success",
            "data": {
                "game_id": game.get("event_id", "Unknown"),
                "team_1": game.get("team_1", "Unknown"),
                "team_2": game.get("team_2", "Unknown"),
                "score_team_1": game.get("score_team_1", 0),
                "score_team_2": game.get("score_team_2", 0),
                "status": game.get("status", "Unknown")
            }
        }), 200
    return jsonify({"status": "error", "message": "Game not found"}), 404

def run_flask():
    print("Starting Flask app on port 5001...")
    app.run(host='0.0.0.0', port=5001)

if __name__ == '__main__':
    flask_thread = threading.Thread(target=run_flask)
    grpc_thread = threading.Thread(target=serve_grpc)

    flask_thread.start()
    grpc_thread.start()

    flask_thread.join()
    grpc_thread.join()
