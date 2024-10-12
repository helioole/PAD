import pytest
import json
import jwt
from unittest.mock import patch, MagicMock
from app import app, SECRET_KEY

@pytest.fixture
def client():
    with app.test_client() as client:
        yield client


@pytest.fixture
def mock_mongo(mocker):
    mock_db = mocker.patch('app.db')
    return mock_db


def test_register_user_success(client, mock_mongo):
    user_data = {
        "username": "testuser",
        "password": "password123",
        "email": "testuser@example.com"
    }

    mock_task = MagicMock()
    mock_task.return_value = {"status": "success", "message": "Registration successful"}
    
    with patch('app.long_running_registration_task', mock_task):
        response = client.post('/api/users/register', data=json.dumps(user_data), content_type='application/json')

        assert response.status_code == 200
        assert b'Registration successful' in response.data


def test_login_user_success(client, mock_mongo):
    mock_mongo.users.find_one.return_value = {
        "username": "testuser",
        "password": "password123",
        "email": "testuser@example.com"
    }

    login_data = {"username": "testuser", "password": "password123"}
    response = client.post('/api/users/login', data=json.dumps(login_data), content_type='application/json')

    assert response.status_code == 200
    assert b'success' in response.data


def test_login_user_failure(client, mock_mongo):
    mock_mongo.users.find_one.return_value = None

    login_data = {"username": "testuser", "password": "wrongpassword"}
    response = client.post('/api/users/login', data=json.dumps(login_data), content_type='application/json')

    assert response.status_code == 401
    assert b'Invalid username or password' in response.data


def test_fetch_user_profile(client, mock_mongo, mocker):
    token = jwt.encode({"username": "testuser"}, SECRET_KEY, algorithm="HS256")

    mock_mongo.users.find_one.return_value = {
        "_id": "testuser_id",
        "username": "testuser",
        "email": "testuser@example.com"
    }

    mock_jwt_decode = mocker.patch('app.jwt.decode')
    mock_jwt_decode.return_value = {"username": "testuser"}

    headers = {'Authorization': f'Bearer {token}'}
    response = client.get('/api/users/me', headers=headers)

    assert response.status_code == 200
    assert b'testuser' in response.data


def test_fetch_user_profile_no_token(client):
    response = client.get('/api/users/me')

    assert response.status_code == 403
    assert b'Token is missing' in response.data

