require('dotenv').config();
const express = require('express');
const proxy = require('express-http-proxy');

const app = express();

const sportsServiceUrl = process.env.SPORTS_SERVICE_URL;
const userServiceUrl = process.env.USER_SERVICE_URL;

if (!sportsServiceUrl || !userServiceUrl) {
    throw new Error('SPORTS_SERVICE_URL or USER_SERVICE_URL is not defined');
}

// API routing to sports service
app.use('/api/sports', proxy(sportsServiceUrl, {
    proxyReqPathResolver: function (req) {
        return '/api/sports' + req.url; 
    }
}));

// API routing to users service
app.use('/api/users', proxy(userServiceUrl, {
    proxyReqPathResolver: function (req) {
        return '/api/users' + req.url;
    }
}));

app.use('/ws/sports', proxy(sportsServiceUrl, { ws: true }));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
});
