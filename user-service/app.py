from flask import Flask, jsonify, request, Response
from pymongo import MongoClient
import jwt
from functools import wraps
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import os
import unittest
from prometheus_client import generate_latest, Counter, Gauge, CollectorRegistry
import threading
from bson.objectid import ObjectId


app = Flask(__name__)

client = MongoClient('mongodb://mongo:27017/')

db = client['user_database']

SECRET_KEY = 'your_secret_key'

executor = ThreadPoolExecutor(max_workers=2)

REQUEST_COUNT = Counter('user_requests_total', 'Total number of requests to user service', ['method', 'endpoint'])
CURRENT_LOAD = Gauge('user_current_load', 'Current load of user service')

@app.route('/metrics', methods=['GET'])
def metrics():
    return Response(generate_latest(), mimetype="text/plain")

# token for authentication
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization')
        if not token:
            return jsonify({'message': 'Token is missing!'}), 403
        
        try:
            token = token.split(" ")[1]
            data = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({'message': 'Token has expired!'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'message': 'Token is invalid!'}), 401
        
        return f(data, *args, **kwargs)
    return decorated

# Task timeout
def long_running_registration_task(user_data):
    print("Simulating registration task...")
    #time.sleep(6)
    db.users.insert_one({
        "username": user_data["username"],
        "password": user_data["password"],
        "email": user_data["email"]
    })
    print("Registration task completed.")
    return {"status": "success", "message": "Registration successful"}

# Register a user
@app.route('/api/users/register', methods=['POST'])
def register_user():
    REQUEST_COUNT.labels('POST', '/api/users/register').inc()
    user_data = request.get_json()

    future = executor.submit(long_running_registration_task, user_data)

    try:
        result = future.result(timeout=5)
        return jsonify(result), 200
    except FuturesTimeoutError:
        future.cancel()
        return jsonify({"status": "error", "message": "Task timed out"}), 504

# User login
@app.route('/api/users/login', methods=['POST'])
def login_user():
    login_data = request.get_json()
    user = db.users.find_one({"username": login_data["username"]})

    if user and user["password"] == login_data["password"]:
        token = jwt.encode({"username": user["username"]}, SECRET_KEY, algorithm="HS256")
        return jsonify({"status": "success", "token": token}), 200
    else:
        return jsonify({"status": "error", "message": "Invalid username or password"}), 401

# Fetch the user's profile
@app.route('/api/users/me', methods=['GET'])
@token_required
def fetch_user_profile(decoded_data):
    username = decoded_data['username']
    user = db.users.find_one({"username": username})

    if user:
        return jsonify({
            "status": "success",
            "data": {
                "user_id": str(user["_id"]),
                "username": user["username"],
                "email": user["email"]
            }
        }), 200
    else:
        return jsonify({"status": "error", "message": "User not found"}), 404

# Update notification preferences
@app.route('/api/users/preferences/notifications', methods=['PUT'])
@token_required
def update_notification_preferences(decoded_data):
    preferences_data = request.get_json()
    username = decoded_data['username']

    db.users.update_one(
        {"username": username},
        {"$set": {"preferences.notifications": preferences_data}}
    )
    return jsonify({"status": "success", "message": "Notification preferences updated"}), 200

@app.route('/api/users/<user_id>', methods=['DELETE'])
def delete_user(user_id):
    try:
        result = db.users.delete_one({"_id": ObjectId(user_id)})
        if result.deleted_count > 0:
            return jsonify({"status": "success", "message": "User deleted successfully"}), 200
        else:
            return jsonify({"status": "error", "message": "User not found"}), 404
    except Exception as e:
        return jsonify({"status": "error", "message": f"Failed to delete user: {str(e)}"}), 500

@app.route('/status', methods=['GET'])
def status():
    REQUEST_COUNT.labels('GET', '/status').inc()
    return jsonify({"status": "User Management Service is running"}), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5002, debug=True)