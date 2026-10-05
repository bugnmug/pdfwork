// Local PeerJS broker for the P2P test (the app uses the public one unless VITE_PEER_* is set).
// Usage: node peer-server.mjs   (listens on 127.0.0.1:9000)
import http from "node:http";
import express from "express";
import { ExpressPeerServer } from "peer";

const app = express();
const server = http.createServer(app);
app.use("/", ExpressPeerServer(server, { path: "/", allow_discovery: false }));
server.listen(9000, "127.0.0.1", () => console.log("peer server on 127.0.0.1:9000"));
