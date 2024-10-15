FROM node:16

WORKDIR /app

COPY package.json .
RUN npm install
RUN npm install @grpc/grpc-js
RUN npm install express-http-proxy
RUN npm install dockerode

COPY . .

EXPOSE 8000

CMD ["node", "app.js"]