const express = require('express');
const { sendGrpcPing } = require('./grpc_client'); 
const axios = require('axios');
const proxy = require('express-http-proxy');
const Docker = require('dockerode');
const docker = new Docker();
const app = express();
const client = require('prom-client');
const { v4: uuidv4 } = require('uuid');

const CIRCUIT_BREAKER_THRESHOLD = 3; 
const TASK_TIMEOUT = 5000;
const COOLING_PERIOD = TASK_TIMEOUT * 3.5;

app.use(express.json());

// Prometheus
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Count of total HTTP requests',
  labelNames: ['method', 'path'],
});
register.registerMetric(httpRequestCounter);

app.use((req, res, next) => {
  httpRequestCounter.labels(req.method, req.path).inc();
  next();
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

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

// Helper function for compensation
async function compensate(sagaId, userId, eventId) {
  console.log(`Compensating for Saga ${sagaId}...`);
  try {
    if (userId) {
      await axios.delete(`${services['user-service'].url}/api/users/${userId}`);
      console.log(`Rolled back user: ${userId}`);
    }
    if (eventId) {
      await axios.delete(`${services['sports-service'].url}/api/sports/events/${eventId}`);
      console.log(`Rolled back event: ${eventId}`);
    }
  } catch (error) {
    console.error(`Compensation failed: ${error.message}`);
  }
}

// Saga Orchestrator Endpoint
app.post('/api/saga/create', async (req, res) => {
  const sagaId = uuidv4();
  const { userData, eventData } = req.body;

  let userId = null;
  let eventId = null;

  try {
    // Step 1: Create User
    const userResponse = await axios.post(`${services['user-service'].url}/api/users/register`, userData);
    userId = userResponse.data.userId;

    // Step 2: Create Event
    const eventResponse = await axios.post(`${services['sports-service'].url}/api/sports/events`, eventData);
    eventId = eventResponse.data.eventId;

    // Saga Completed
    res.status(200).json({
      message: 'Saga completed successfully',
      sagaId,
      userId,
      eventId,
    });
  } catch (error) {
    console.error(`Saga failed: ${error.message}`);
    await compensate(sagaId, userId, eventId);
    res.status(500).json({ error: 'Saga failed and changes were rolled back' });
  }
});

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

    console.log(`Updated URLs for ${serviceName}:`, service.urls);

    initializeServiceProperties(service);

    if (!service.urls.length) {
      console.warn(`No replicas found for ${serviceName}.`);
    }
  } catch (error) {
    console.error(`Failed to update service URLs for ${serviceName}:`, error.message);
  }
}

// Circuit Breaker logic with Alerts and Service removal
async function handleCircuitBreaker(service, serviceName, replicaIndex) {
  const now = Date.now();

  console.log(`Checking circuit breaker for ${serviceName}, replica at ${service.urls[replicaIndex]}...`);
  console.log(`Failure count: ${service.failureCounts[replicaIndex]}, Threshold: ${CIRCUIT_BREAKER_THRESHOLD}`);

  if (service.isBreakerOpen[replicaIndex] && (now - service.lastFailureTimes[replicaIndex]) > COOLING_PERIOD) {
    console.log(`Cooling period ended for ${service.urls[replicaIndex]}. Resetting breaker.`);
    service.failureCounts[replicaIndex] = 0;
    service.isBreakerOpen[replicaIndex] = false;
    service.lastFailureTimes[replicaIndex] = null;
    return;
  }

  if (service.failureCounts[replicaIndex] >= CIRCUIT_BREAKER_THRESHOLD) {
    console.error(`ALERT: Circuit breaker tripped for replica at ${service.urls[replicaIndex]}.`);

    const containerId = service.containerIds[replicaIndex];
    console.log(`Stopping and removing Docker container for IP: ${service.urls[replicaIndex]} with container ID: ${containerId}...`);

    try {
      const container = docker.getContainer(containerId);
      await container.stop();
      console.log(`Container ${containerId} stopped successfully.`);

      await container.remove();
      console.log(`Container ${containerId} removed successfully.`);

      // Remove the replica from service properties
      const removedReplica = service.urls.splice(replicaIndex, 1);
      service.failureCounts.splice(replicaIndex, 1);
      service.isBreakerOpen.splice(replicaIndex, 1);
      service.lastFailureTimes.splice(replicaIndex, 1);
      service.loadCounters.splice(replicaIndex, 1);
      service.containerIds.splice(replicaIndex, 1);

      console.log(`Replica ${removedReplica} removed from ${serviceName} service configuration.`);
    } catch (err) {
      console.error(`Failed to stop or remove Docker container ${containerId}:`, err.message);
    }
  }
}

async function makeThreeRequests(serviceName, replicaIndex) {
  const service = services[serviceName];
  const replicaUrl = service.urls[replicaIndex];
  let failureCount = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Attempt ${attempt}: Sending request to ${replicaUrl} (Replica ${replicaIndex + 1})...`);

      const response = await axios.get(`${replicaUrl}/simulate-failure`);

      if (response.data.success === false || response.status !== 200) {
        throw new Error("Simulated failure based on endpoint response");
      }

      console.log(`Attempt ${attempt} succeeded for replica ${replicaIndex + 1}.`);
      service.failureCounts[replicaIndex] = 0;
      return true;

    } catch (error) {
      console.error(`Attempt ${attempt} for replica ${replicaIndex + 1} failed: ${error.message}`);
      failureCount++;
      service.failureCounts[replicaIndex]++;
    }
  }

  console.log(`Total failures for replica ${replicaIndex + 1}: ${failureCount}`);

  if (failureCount >= 3) {
    console.log(`Circuit breaker tripped for replica ${replicaUrl}.\n`);
    service.isBreakerOpen[replicaIndex] = true;
    service.lastFailureTimes[replicaIndex] = Date.now();
  }

  return false;
}

async function makeThreeRequests(serviceName, replicaIndex) {
  const service = services[serviceName];
  const replicaUrl = service.urls[replicaIndex];
  let failureCount = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Attempt ${attempt}: Sending request to ${replicaUrl} (Replica ${replicaIndex + 1})...`);

      const response = await axios.get(`${replicaUrl}/simulate-failure`);

      if (response.data.success === false || response.status !== 200) {
        throw new Error("Simulated failure based on endpoint response");
      }

      console.log(`Attempt ${attempt} succeeded for replica ${replicaIndex + 1}.`);
      service.failureCounts[replicaIndex] = 0;
      return true;

    } catch (error) {
      console.error(`Attempt ${attempt} for replica ${replicaIndex + 1} failed: ${error.message}`);
      failureCount++;
      service.failureCounts[replicaIndex]++;
    }
  }

  console.log(`Total failures for replica ${replicaIndex + 1}: ${failureCount}`);

  if (failureCount >= 3) {
    console.log(`Circuit breaker tripped for replica ${replicaUrl}.\n`);
    service.isBreakerOpen[replicaIndex] = true;
    service.lastFailureTimes[replicaIndex] = Date.now();
  }

  return false;
}

async function makeThreeRequestsWithRemoval(serviceName, replicaIndex) {
  const service = services[serviceName];
  const replicaUrl = service.urls[replicaIndex];
  let failureCount = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Attempt ${attempt}: Sending request to ${replicaUrl} (Replica ${replicaIndex + 1})...`);

      const response = await axios.get(`${replicaUrl}/simulate-failure`);

      if (response.data.success === false || response.status !== 200) {
        throw new Error("Simulated failure based on endpoint response");
      }

      console.log(`Attempt ${attempt} succeeded for replica ${replicaIndex + 1}.`);
      service.failureCounts[replicaIndex] = 0;
      return true;

    } catch (error) {
      console.error(`Attempt ${attempt} for replica ${replicaIndex + 1} failed: ${error.message}`);
      failureCount++;
      service.failureCounts[replicaIndex]++;
    }
  }

  console.log(`Total failures for replica ${replicaIndex + 1}: ${failureCount}`);

  if (failureCount >= 3) {
    console.log(`Circuit breaker tripped for replica ${replicaUrl}.\n`);
    service.isBreakerOpen[replicaIndex] = true;
    service.lastFailureTimes[replicaIndex] = Date.now();
    await handleCircuitBreaker(service, 'sports-service', replicaIndex);
  }

  return false;
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

setInterval(() => {
  Object.keys(services).forEach(serviceName => {
    const service = services[serviceName];
    service.urls.forEach((_, index) => {
      if (
        service.isBreakerOpen[index] &&
        Date.now() - service.lastFailureTimes[index] > COOLING_PERIOD
      ) {
        console.log(`Circuit breaker reset for replica ${index} of ${serviceName}.`);
        service.isBreakerOpen[index] = false;
        service.failureCounts[index] = 0;
      }
    });
  });
}, 5000);

(async () => {
  try {
    console.log('Updating service URLs...');
    await updateServiceUrls('sports-service');
    await updateServiceUrls('user-service');
  } catch (error) {
    console.error('Error during initialization or testing:', error.message);
  }
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

app.get('/test-replicas-with-removal', async (req, res) => {
  const serviceName = 'sports-service';
  try {
    const service = services[serviceName];

    if (!service || !service.urls || service.urls.length === 0) {
      throw new Error(`${serviceName} has no replicas configured. Please ensure the service is correctly initialized.`);
    }

    console.log(`Testing replicas for service: ${serviceName}`);

    while (service.urls.length > 0) {
      const replicaUrl = service.urls[0];
      console.log(`Testing replica at URL: ${replicaUrl}`);

      const success = await makeThreeRequestsWithRemoval(serviceName, 0);

      if (success) {
        console.log(`Replica succeeded: ${replicaUrl}`);
        res.json({ message: `Replica succeeded: ${replicaUrl}` });
        return;
      }

      console.log(`Replica failed after 3 attempts: ${replicaUrl}`);
    }

    console.error(`All replicas for ${serviceName} failed.`);
    res.status(503).json({ message: `All replicas for ${serviceName} failed.` });
  } catch (error) {
    console.error(`Error testing replicas: ${error.message}`);
    res.status(500).json({ message: `Error testing replicas: ${error.message}` });
  }
});

app.get('/test-replicas', async (req, res) => {
  const serviceName = 'sports-service';
  try {
    const service = services[serviceName];

    if (!service || !service.urls || service.urls.length === 0) {
      throw new Error(`${serviceName} has no replicas configured. Please ensure the service is correctly initialized.`);
    }

    console.log(`Testing replicas for service: ${serviceName}`);

    for (let i = 0; i < service.urls.length; i++) {
      const replicaUrl = service.urls[i];
      console.log(`Testing replica ${i + 1} at URL: ${replicaUrl}`);

      const success = await makeThreeRequests(serviceName, i);

      if (success) {
        console.log(`Replica ${i + 1} succeeded.`);
        res.json({ message: `Replica ${i + 1} succeeded.` });
        return;
      }

      console.log(`Replica ${i + 1} failed after 3 attempts.`);
    }

    console.error(`All replicas for ${serviceName} failed.`);
    res.status(503).json({ message: `All replicas for ${serviceName} failed.` });
  } catch (error) {
    console.error(`Error testing replicas: ${error.message}`);
    res.status(500).json({ message: `Error testing replicas: ${error.message}` });
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
});
