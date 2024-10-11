require('dotenv').config();
const express = require('express');
const proxy = require('express-http-proxy');
const axios = require('axios');

const app = express();

// Store available services and their status
const services = {
    'sports-service': { url: process.env.SPORTS_SERVICE_URL, status: 'unknown' },
    'user-service': { url: process.env.USER_SERVICE_URL, status: 'unknown' }
};

// Health check function for services
async function checkServiceHealth(serviceName, serviceUrl) {
    try {
        const response = await axios.get(`${serviceUrl}/status`);
        if (response.status === 200) {
            services[serviceName].status = 'healthy';
        } else {
            services[serviceName].status = 'unhealthy';
        }
    } catch (error) {
        console.error(`Error checking health of ${serviceName}:`, error.message);
        services[serviceName].status = 'unhealthy';
    }
}


// Periodically check the health of services
setInterval(() => {
    Object.keys(services).forEach(serviceName => {
        checkServiceHealth(serviceName, services[serviceName].url);
    });
}, 30000);  // Check every 30 seconds


// Helper function to get available service URL
function getAvailableService(serviceName) {
    const service = services[serviceName];
    if (service.status === 'healthy') {
        return service.url;
    }
    throw new Error(`${serviceName} is currently unavailable`);
}

// Proxy to sports service using service discovery
app.use('/api/sports', (req, res, next) => {
    try {
        const sportsServiceUrl = getAvailableService('sports-service');
        proxy(sportsServiceUrl, {
            proxyReqPathResolver: function (req) {
                return '/api/sports' + req.url;
            }
        })(req, res, next);
    } catch (error) {
        res.status(503).json({ message: error.message });
    }
});

// Proxy to user service using service discovery
app.use('/api/users', (req, res, next) => {
    try {
        const userServiceUrl = getAvailableService('user-service');
        proxy(userServiceUrl, {
            proxyReqPathResolver: function (req) {
                return '/api/users' + req.url;  // Ensures the full URL path is passed to the user-service
            }
        })(req, res, next);
    } catch (error) {
        res.status(503).json({ message: error.message });
    }
});

app.use('/ws/sports', (req, res, next) => {
    try {
        const sportsServiceUrl = getAvailableService('sports-service');
        proxy(sportsServiceUrl, { ws: true })(req, res, next);
    } catch (error) {
        res.status(503).json({ message: error.message });
    }
});


// Status Endpoint for Gateway
app.get('/status', (req, res) => {
    res.json({
        message: 'API Gateway is running',
        timestamp: new Date(),
        services
    });
});

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});


const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
});
