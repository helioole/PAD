const express = require('express');
const { sendGrpcPing } = require('./grpc_client'); 
const axios = require('axios');
const proxy = require('express-http-proxy');
const Docker = require('dockerode');
const docker = new Docker();
const app = express();

const CIRCUIT_BREAKER_THRESHOLD = 3; 
const TASK_TIMEOUT = 5000;
const COOLING_PERIOD = TASK_TIMEOUT * 3.5;

app.use(express.json());


const services = {
  'sports-service': { 
    url: process.env.SPORTS_SERVICE_URL || 'http://sports-service:5001',
    status: 'unknown',
    urls: [], 
    failureCounts: [],
    isBreakerOpen: [],
    lastFailureTimes: [],
    loadCounters: [],
    containerIds: [],
    currentIndex: 0 
  },
  'user-service': { 
    url: process.env.USER_SERVICE_URL || 'http://user-service:5002',
    status: 'unknown',
    urls: [], 
    failureCounts: [],
    isBreakerOpen: [],
    lastFailureTimes: [],
    loadCounters: [],
    containerIds: [],
    currentIndex: 0 
  }
};

const CRITICAL_LOAD_THRESHOLD = 5;
let loadCounter = 0;
let startTime = Date.now();

function checkLoad() {
  const currentTime = Date.now();
  const elapsedTime = (currentTime - startTime) / 1000;

  if (elapsedTime >= 1.0) {
    if (loadCounter > CRITICAL_LOAD_THRESHOLD) {
      console.log(`ALERT: Load threshold exceeded with ${loadCounter} requests in the last second.`);
    } else {
      console.log(`INFO: Load below threshold: ${loadCounter} requests in the last second.`);
    }
    loadCounter = 0;
    startTime = currentTime;
  }
}

async function getServiceLoad(service) {
  const loadPromises = service.urls.map(async (replica, index) => {
    if (!service.isBreakerOpen[index]) {
      try {
        const response = await axios.get(`${replica}/status`);
        service.loadCounters[index] = response.data.current_load || 0; 
      } catch (error) {
        console.error(`Error getting load from ${replica}:`, error.message);
        service.loadCounters[index] = Infinity;
      }
    } else {
      service.loadCounters[index] = Infinity;
    }
  });

  await Promise.all(loadPromises);
}

function getLeastLoadedService(serviceName) {
  const service = services[serviceName];
  if (!service) {
    throw new Error(`Service ${serviceName} is not defined`);
  }

  let leastLoadedReplica = null;
  let minLoad = Infinity;

  service.urls.forEach((replicaUrl, index) => {
    const currentLoad = service.loadCounters[index];
    if (!service.isBreakerOpen[index] && currentLoad < minLoad) {
      minLoad = currentLoad;
      leastLoadedReplica = { url: replicaUrl, currentLoad };
      console.log(`Candidate for least loaded replica: ${replicaUrl} with load: ${currentLoad}`);
    }
  });

  if (leastLoadedReplica) {
    console.log(`Least loaded replica chosen: ${leastLoadedReplica.url} with load: ${leastLoadedReplica.currentLoad}`);
    return leastLoadedReplica;
  } else {
    throw new Error(`All replicas for ${serviceName} are down or unavailable`);
  }
}

function sendMultipleRequests(count) {
  loadCounter = 0;
  for (let i = 0; i < count; i++) {
    sendGrpcPing((error, response) => {
      if (!error) {
        loadCounter++;
        checkLoad();
      }
    });
  }
}

function initializeServiceProperties(service) {
  const replicaCount = service.urls.length;

  service.failureCounts = new Array(replicaCount).fill(0);
  service.isBreakerOpen = new Array(replicaCount).fill(false);
  service.lastFailureTimes = new Array(replicaCount).fill(null);
  service.loadCounters = new Array(replicaCount).fill(0);

  console.log(`Service properties initialized for ${replicaCount} replicas.`);
}
async function updateServiceUrls(serviceName) {
  try {
    const service = services[serviceName];
    const containers = await docker.listContainers({ all: false });

    service.urls = [];
    service.containerIds = [];

    containers.forEach(container => {
      const containerName = container.Names[0];

      if (containerName.includes(serviceName)) {
        const networkInfo = container.NetworkSettings.Networks['pad_app-network']; 

        if (networkInfo && networkInfo.IPAddress) {
          const containerIp = networkInfo.IPAddress;
          const containerPort = serviceName === 'user-service' ? 5002 : 5001; 

          const serviceUrl = `http://${containerIp}:${containerPort}`;

          service.urls.push(serviceUrl);
          service.containerIds.push(container.Id);
        }
      }
    });

    initializeServiceProperties(service);

    console.log(`Updated URLs for ${serviceName}: `, service.urls);
  } catch (error) {
    console.error(`Failed to update service URLs for ${serviceName}: `, error.message);
  }
}


// Circuit Breaker logic with Alerts and Service removal
async function handleCircuitBreaker(service, serviceName, replicaIndex) {
  const now = Date.now();

  console.log(`Checking circuit breaker for ${serviceName}, replica ${replicaIndex}...`);
  console.log(`Failure count: ${service.failureCounts[replicaIndex]}, Threshold: ${CIRCUIT_BREAKER_THRESHOLD}`);

  if (service.isBreakerOpen[replicaIndex] && (now - service.lastFailureTimes[replicaIndex]) > COOLING_PERIOD) {
    console.log(`${serviceName} replica ${replicaIndex} breaker cooling period ended. Resetting breaker.`);
    service.failureCounts[replicaIndex] = 0;
    service.isBreakerOpen[replicaIndex] = false;
    service.lastFailureTimes[replicaIndex] = null;
    return;
  }

  if (service.failureCounts[replicaIndex] >= CIRCUIT_BREAKER_THRESHOLD) {
    if (!service.isBreakerOpen[replicaIndex]) {
      console.error(`ALERT: ${serviceName} replica ${replicaIndex} Circuit Breaker tripped due to ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures.`);
    }

    service.isBreakerOpen[replicaIndex] = true;
    service.lastFailureTimes[replicaIndex] = now;

    const containerId = service.containerIds[replicaIndex];
    console.log(`Stopping and removing Docker container for IP: ${service.urls[replicaIndex]} with container ID: ${containerId}...`);

    try {
      const container = docker.getContainer(containerId);
      await container.stop();
      console.log(`Container ${containerId} stopped successfully.`);

      await container.remove();
      console.log(`Container ${containerId} removed successfully.`);

      service.urls.splice(replicaIndex, 1);
      service.failureCounts.splice(replicaIndex, 1);
      service.isBreakerOpen.splice(replicaIndex, 1);
      service.lastFailureTimes.splice(replicaIndex, 1);
      service.loadCounters.splice(replicaIndex, 1);
      service.containerIds.splice(replicaIndex, 1);

      console.log(`Replica ${replicaIndex} removed from ${serviceName} service configuration.`);

    } catch (err) {
      console.error(`Failed to stop or remove Docker container ${containerId}:`, err.message);
    }
  }
}

// Function to send 3 requests to a sports-service replica
async function makeThreeRequests(serviceUrl, replicaIndex) {
  let failureCount = 0;

  for (let i = 0; i < 3; i++) {
    try {
      if (replicaIndex === 0) {
        throw new Error(`Simulated failure for replica ${replicaIndex}`);
      }

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

  console.log(`Failure count for replica ${replicaIndex}: ${service.failureCounts[replicaIndex]}`);

  await handleCircuitBreaker(service, 'sports-service', replicaIndex);
}

// Endpoint to test all sports-service replicas
async function testAllReplicas() {
  const service = services['sports-service'];
  for (let i = 0; i < service.urls.length; i++) {
    console.log(`Testing replica ${i + 1} at URL: ${service.urls[i]}`);
    await makeThreeRequests(service.urls[i], i);
  }
}

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
    updateServiceUrls(serviceName);
  });
}, 30000);

(async () => {
  await updateServiceUrls('sports-service');
  await updateServiceUrls('user-service');
})();

// Helper function to get available service URL
function getAvailableService(serviceName) {
  const service = services[serviceName];

  if (!service || !service.urls || service.urls.length === 0) {
    throw new Error(`${serviceName} is unavailable or has no valid URLs`);
  }

  if (service.status === 'healthy') {
    return service.url; 
  } else {
    throw new Error(`${serviceName} is currently unhealthy`);
  }
}

app.get('/test-replicas', async (req, res) => {
  try {
    const serviceName = 'sports-service';
    const service = services[serviceName];
    
    for (let i = 0; i < service.urls.length; i++) {
      console.log(`Testing replica ${i + 1} at URL: ${service.urls[i]}`);
      await makeThreeRequests(service.urls[i], i);
    }

    res.json({ message: 'Replica testing completed' });
  } catch (error) {
    console.error(`Error testing replicas: `, error.message);
    res.status(500).json({ message: 'Replica testing failed' });
  }
});


// Proxy for sport service
app.use('/api/sports', async (req, res, next) => {
  try {
    await getServiceLoad(services['sports-service']); 

    const leastLoadedReplica = getLeastLoadedService('sports-service');
    if (!leastLoadedReplica) {
      return res.status(503).json({ message: 'No available sports-service replicas' });
    }

    console.log(`Forwarding request to ${leastLoadedReplica.url}`);
    
    proxy(leastLoadedReplica.url, {
      proxyReqPathResolver: (req) => {
        return '/api/sports' + req.url;
      }
    })(req, res, next);

  } catch (error) {
    console.error(error.message);
    res.status(503).json({ message: error.message });
  }
});


// Proxy for user service
app.use('/api/users', async (req, res, next) => {
  try {
    const userServiceUrl = services['user-service'].url;
    await checkServiceHealth('user-service', userServiceUrl); 

    if (services['user-service'].status === 'healthy') {
      proxy(userServiceUrl, {
        proxyReqPathResolver: (req) => {
          return '/api/users' + req.url;
        }
      })(req, res, next);
    } else {
      res.status(503).json({ message: 'User-service is currently unhealthy' });
    }
  } catch (error) {
    res.status(503).json({ message: error.message });
  }
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    message: 'API Gateway is running',
    timestamp: new Date(),
    services
  });
});

app.get('/send-multiple-grpc-pings', (req, res) => {
  const numRequests = parseInt(req.query.count, 10) || 10;
  sendMultipleRequests(numRequests);
  res.json({ message: `Started sending ${numRequests} gRPC requests.` });
});

app.listen(8000, () => {
  console.log(`API Gateway running on port 8000`);
  testAllReplicas();
});