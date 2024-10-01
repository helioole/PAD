require('dotenv').config();
const express = require('express');
const proxy = require('express-http-proxy');

const app = express();

// Define environment variables for service URLs
const sportsServiceUrl = process.env.SPORTS_SERVICE_URL;
const userServiceUrl = process.env.USER_SERVICE_URL;

if (!sportsServiceUrl || !userServiceUrl) {
    throw new Error('SPORTS_SERVICE_URL or USER_SERVICE_URL is not defined');
}

// Proxy requests to the Sports Management Service
app.use('/api/sports', proxy(sportsServiceUrl, {
    proxyReqPathResolver: function (req) {
        return '/api/sports' + req.url; // Preserve the path
    }
}));

// Proxy requests to the User and Notification Service
app.use('/api/users', proxy(userServiceUrl, {
    proxyReqPathResolver: function (req) {
        return '/api/users' + req.url; // Preserve the path
    }
}));

// WebSocket proxy for real-time sports updates
app.use('/ws/sports', proxy(sportsServiceUrl, { ws: true }));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
});

