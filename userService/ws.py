
import json
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import List
import redis

app = FastAPI()

# Redis client setup
redis_client = redis.Redis(host='localhost', port=6379, decode_responses=True)
connected_users: List[WebSocket] = []

# Subscribe to Redis channel for incoming messages asynchronously
async def redis_listener():
    pubsub = redis_client.pubsub()
    pubsub.subscribe("chat_channel")

    loop = asyncio.get_running_loop()

    print("Redis listener started...")

    while True:
        message = await loop.run_in_executor(None, pubsub.get_message)
        if message and message['type'] == 'message':
            print(f"Message received from Redis: {message}")  
            data = json.loads(message['data'])
            print(f"Parsed message data: {data}") 
            await broadcast_to_users(data)

# Function to broadcast messages to all connected users
async def broadcast_to_users(data):
    if connected_users:
        print(f"Broadcasting message to {len(connected_users)} users")
        for user in connected_users:
            try:
                print(f"Sending message to user: {data}")
                await user.send_text(f"Message from Redis: {data['content']} by user {data['user_id']}")
            except Exception as e:
                print(f"Error sending message: {e}")
    else:
        print("No connected users to broadcast to.")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print(f"New WebSocket connection: {websocket.client}")
    connected_users.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()  
            print(f"Message received from WebSocket client: {data}")  

            message_data = {
                "user_id": "user",  
                "content": data
            }
            redis_client.publish("chat_channel", json.dumps(message_data))
            print(f"Message published to Redis: {message_data}")
    except WebSocketDisconnect:
        connected_users.remove(websocket)  
        print(f"WebSocket disconnected: {websocket.client}")
        await broadcast_to_users({"content": "A user has left the chat.", "user_id": "system"})

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(redis_listener())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="localhost", port=3000)


