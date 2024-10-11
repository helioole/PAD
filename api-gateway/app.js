const express = require('express');
const proxy = require('express-http-proxy');
const axios = require('axios');
const dns = require('dns').promises;

const app = express();

// Function to resolve the IPs of the service replicas dynamically
async function resolveServiceUrls(serviceName, port) {
    try {
        const addresses = await dns.lookup(serviceName, { all: true });
        return addresses.map(address => `http://${address.address}:${port}`);
    } catch (error) {
        console.error(`Error resolving service URLs for ${serviceName}:`, error);
        return [];
    }
}

// Store available services and their status dynamically
const services = {
    'sports-service': { urls: [], status: [], currentIndex: 0 },
    'user-service': { urls: [], status: [], currentIndex: 0 }
};

// Initialize service URLs and statuses dynamically
async function initializeServices() {
    services['sports-service'].urls = await resolveServiceUrls('sports-service', 5001);
    services['sports-service'].status = new Array(services['sports-service'].urls.length).fill('unknown');
    
    services['user-service'].urls = await resolveServiceUrls('user-service', 5002);
    services['user-service'].status = new Array(services['user-service'].urls.length).fill('unknown');
}

// Health check function for services
async function checkServiceHealth(serviceName) {
    const service = services[serviceName];
    for (let i = 0; i < service.urls.length; i++) {
        try {
            const response = await axios.get(`${service.urls[i]}/status`);
            service.status[i] = response.status === 200 ? 'healthy' : 'unhealthy';
        } catch (error) {
            console.error(`Error checking health of ${serviceName} instance ${i}:`, error.message);
            service.status[i] = 'unhealthy';
        }
    }
}

// Periodically check the health of services
setInterval(() => {
    Object.keys(services).forEach(serviceName => {
        checkServiceHealth(serviceName);
    });
}, 30000);  // Check every 30 seconds

// Helper function to get available service URL using Round Robin
function getAvailableService(serviceName) {
    const service = services[serviceName];
    const { urls, status, currentIndex } = service;

    // Find the next healthy service using round robin
    for (let i = 0; i < urls.length; i++) {
        const index = (currentIndex + i) % urls.length;
        if (status[index] === 'healthy') {
            service.currentIndex = (index + 1) % urls.length;
            return urls[index];
        }
    }
    throw new Error(`${serviceName} is currently unavailable`);
}

// Proxy to sports service using Round Robin
app.use('/api/sports', async (req, res, next) => {
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

// Proxy to user service using Round Robin
app.use('/api/users', async (req, res, next) => {
    try {
        const userServiceUrl = getAvailableService('user-service');
        proxy(userServiceUrl, {
            proxyReqPathResolver: function (req) {
                return '/api/users' + req.url;
            }
        })(req, res, next);
    } catch (error) {
        res.status(503).json({ message: error.message });
    }
});

// WebSocket proxy for sports service
app.use('/ws/sports', async (req, res, next) => {
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

// Logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Initialize services on startup
initializeServices().then(() => {
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
        console.log(`API Gateway running on port ${PORT}`);
    });
});
