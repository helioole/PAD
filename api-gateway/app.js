const express = require('express');
const axios = require('axios');
const dns = require('dns').promises;

const app = express();

const CIRCUIT_BREAKER_THRESHOLD = 3; 
const TASK_TIMEOUT = 5000;
const COOLING_PERIOD = TASK_TIMEOUT * 3.5;

// Store available services and their circuit breaker status dynamically
const services = {
    'sports-service': { 
        urls: ['http://172.19.0.7:5001', 'http://172.19.0.8:5001', 'http://172.19.0.9:5001'],
        failureCounts: [0, 0, 0],
        isBreakerOpen: [false, false, false],
        lastFailureTimes: [null, null, null],
        currentIndex: 0 
    }
};

// Circuit Breaker logic with Alerts
function handleCircuitBreaker(service, serviceName, replicaIndex) {
    const now = Date.now();

    if (service.isBreakerOpen[replicaIndex] && (now - service.lastFailureTimes[replicaIndex]) > COOLING_PERIOD) {
        console.log(`${serviceName} replica ${replicaIndex} breaker cooling period ended. Resetting breaker.`);
        service.failureCounts[replicaIndex] = 0;
        service.isBreakerOpen[replicaIndex] = false;
        service.lastFailureTimes[replicaIndex] = null;
    }
    
    if (service.failureCounts[replicaIndex] >= CIRCUIT_BREAKER_THRESHOLD) {
        if (!service.isBreakerOpen[replicaIndex]) {
            console.error(`ALERT: ${serviceName} replica ${replicaIndex} Circuit Breaker tripped due to ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures.`);
        }
        service.isBreakerOpen[replicaIndex] = true;
        service.lastFailureTimes[replicaIndex] = now;
    }
}

// Function to simulate 3 requests to a specific sports-service replica
async function makeThreeRequests(serviceUrl, replicaIndex) {
    let failureCount = 0;

    for (let i = 0; i < 3; i++) {
        try {
            console.log(`Attempt ${i + 1}: Sending request to ${serviceUrl}/status`);

            const response = await axios.get(`${serviceUrl}/status`);

            if (response.status !== 200) {
                console.log(`Attempt ${i + 1} failed with status: ${response.status}`);
                failureCount++;
            } else {
                console.log(`Attempt ${i + 1} succeeded with status: ${response.status}`);
            }

        } catch (error) {
            console.error(`Attempt ${i + 1} encountered an error: ${error.message}`);
            failureCount++;
        }
    }

    console.log(`Total failures after 3 attempts: ${failureCount}`);

    const service = services['sports-service'];
    service.failureCounts[replicaIndex] += failureCount;

    handleCircuitBreaker(service, 'sports-service', replicaIndex);

    if (failureCount >= 3) {
        console.error(`ALERT: All 3 requests to ${serviceUrl} failed.`);
    }
}

// Helper function to trigger 3 requests for all sports-service replicas
async function testAllReplicas() {
    const service = services['sports-service'];
    
    for (let i = 0; i < service.urls.length; i++) {
        console.log(`Testing replica ${i + 1} at URL: ${service.urls[i]}`);
        await makeThreeRequests(service.urls[i], i);
    }
}

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

// Initialize and run tests for all sports-service replicas
app.listen(8000, () => {
    console.log(`API Gateway running on port 8000`);
    
    testAllReplicas();
});
