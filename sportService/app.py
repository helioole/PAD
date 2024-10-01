from flask import Flask, jsonify, request
from pymongo import MongoClient

app = Flask(__name__)

client = MongoClient('localhost', 27017)
db = client['sports_database'] 

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
    db.events.insert_one(event_data)
    return jsonify({"status": "success", "message": "Event added"}), 201

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

if __name__ == '__main__':
    app.run(debug=True, port=5001)
