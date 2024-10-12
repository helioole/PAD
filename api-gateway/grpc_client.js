const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, 'sports_service.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const sportsProto = grpc.loadPackageDefinition(packageDefinition).sportsservice;

// Create gRPC client
const client = new sportsProto.SportsService('sports-service:50051', grpc.credentials.createInsecure());

// Function to send a single Ping request
function sendGrpcPing(callback) {
  client.Ping({ message: 'Ping from API Gateway' }, (error, response) => {
    if (error) {
      console.error('gRPC Error:', error);
      callback(error);
    } else {
      callback(null, response);
    }
  });
}

module.exports = { sendGrpcPing };
