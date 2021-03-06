const WebSocket = require('ws');
const request = require('request');
const jwt = require('jsonwebtoken');


module.exports = function(RED) {

    const RECONNECT_TIMEOUT_MS = 10000;
    let devices = {};
    let config = undefined;
    let token = undefined;
    let timeout = undefined;
    let node = this;

    let websockets = {};

    function handleReconnection(){
        for(let id in devices){
            let device = devices[id];
            if(device.wss && (device.wss.readyState === device.wss.CLOSED)){
                device.wss = getDeviceWebsocket(id);
            }
        }
    }

    function closeWebsockets(){
        for(let id in devices){
            let device = devices[id];
            if(device.wss){
                device.wss.close();
            }
        }
    }

    function ThingerServerNode(configa) {
        RED.nodes.createNode(this, configa);

        node = this;
        config = configa;

        if(this.credentials && this.credentials.hasOwnProperty("token")) {
            let provided_token = this.credentials.token;
            // get the decoded payload and header
            let decoded = jwt.decode(provided_token, {complete: true});
            if (decoded && decoded.payload.usr) {
                config.username = decoded.payload.usr;
                configa.token = provided_token;
                token = provided_token
            } else {
                node.error("Invalid JWT Token");
                return;
            }
        }else{
            node.error("Please, provide the Access Token");
            return;
        }

        node.on('close', function(removed, done) {
            // clear reconnection timeout
            clearTimeout(timeout);

            // close device connections
            closeWebsockets();

            done();
        });

        node.openWebsocket = function(node, path, on_open, on_message, on_close, on_error){
            const url = (config.ssl ? 'wss://' : "ws://") + config.host + "/v1/users/" + config.username + path + "?authorization=" + config.token;
            node.log("opening websocket to: " + url);
            let wss = new WebSocket(url);

            wss.on('error', function(e){
                node.status({fill:"red", shape:"dot", text: 'websocket error'});
                node.error(e && e.message ? e.message : "websocket error");
                if(on_error) on_error(e);
            });

            wss.on('open', function open() {
                node.status({fill:"green", shape:"dot", text: 'connected'});
                if(on_open) on_open();
            });

            wss.on('message', function incoming(data) {
                // parse incoming data
                let payload = JSON.parse(data);
                node.status({fill:"blue",shape:"dot",text:"connected"});
                if(on_message) on_message(payload);
                node.status({fill:"green",shape:"dot",text:"connected"});
            });

            wss.on('close', function close() {
                node.status({fill:"red", shape:"dot", text: 'disconnected'});
                if(on_close) on_close();
            });

            return wss;
        };

        node.callEndpoint = function(endpointId, data){
            const url = (config.ssl ? 'https://' : "http://") + config.host + "/v1/users/" + config.username + "/endpoints/" + endpointId + "/call?authorization=" + token;
            request({
                url: url,
                method: "POST",
                json: true,
                body: data
            }, function (error, response, body){
                node.log(response);
            });
        };

        node.writeBucket = function(bucketId, data){
            const url = (config.ssl ? 'https://' : "http://") + config.host + "/v1/users/" + config.username + "/buckets/" + bucketId + "/data?authorization=" + token;
            request({
                url: url,
                method: "POST",
                json: true,
                body: data
            }, function (error, response, body){
                node.log(response);
            });
        };

        node.readDevice = function(deviceId, resourceId, handler){
            const url = (config.ssl ? 'https://' : "http://") + config.host + "/v3/users/" + config.username + "/devices/" + deviceId + "/resources/" + resourceId + "?authorization=" + token;
            node.log(url);
            request({
                url: url,
                method: "GET",
                json: true
            }, handler);
        };

        node.writeDevice = function(deviceId, resourceId, data){
            const url = (config.ssl ? 'https://' : "http://") + config.host + "/v3/users/" + config.username + "/devices/" + deviceId + "/resources/" + resourceId + "?authorization=" + token;
            request({
                url: url,
                method: "POST",
                json: true,
                body: {in : data}
            }, function (error, response, body){
                node.log(response);
            });
        };

        node.unRegisterDeviceResourceListener = function (deviceId, resourceId, node){
            // check the device exists
            let device = devices[deviceId];
            if(!device) return;

            // check the resource exists
            let resource = device.resources[resourceId];
            if(!resource) return;

            // check that the listener is on
            if(resource.listeners[node.id]){
                delete resource.listeners[node.id];
                node.log("Listener Cleared");

                controlDeviceResourceStreaming(device, resource);

                // no more listeners in the resource
                if(!Object.keys(resource.listeners).length){
                    delete device.resources[resourceId];
                    node.log("Resource Cleared");

                    // device has no any resource
                    if(!Object.keys(device.resources).length){
                        // close websocket
                        if(device.wss){
                            node.log("Websocket Closed");
                            device.wss.close();
                        }
                        // delete device
                        delete devices[deviceId];
                        node.log("Device Cleared");

                    }
                }
            }
        };

        node.registerDeviceResourceListener = function(deviceId, resourceId, interval, node) {
            // initialize the device if it does not exists
            let device = devices[deviceId];
            if(device === undefined){
                device = devices[deviceId] = {
                    id : deviceId,
                    resources: {}
                };
            }

            // initialize device resource
            let resource = device.resources[resourceId];
            if(resource === undefined){
                resource = device.resources[resourceId] = {
                    id: resourceId,
                    interval: undefined,
                    listeners : {}
                };
            }

            // add listener
            resource.listeners[node.id] = {
                interval : interval,
                node: node
            };

            // control the device streaming
            controlDeviceResourceStreaming(device, resource);
        };

        timeout = setTimeout(function tick() {
            handleReconnection();
            timeout = setTimeout(tick, RECONNECT_TIMEOUT_MS);
        }, RECONNECT_TIMEOUT_MS);
    }

    function controlDeviceResourceStreaming(device, resource){
        // there are listeners (or nodes) waiting for information
        if(Object.keys(resource.listeners).length){
            // get current resource interval
            let currentInterval = resource.interval;

            // set resource interval to the greatest common divisor of all listeners
            resource.interval = getDeviceResourceInterval(device, resource);

            // update skip values for listeners
            for(let id in resource.listeners){
                let listener = resource.listeners[id];
                if(listener.interval!==resource.interval){
                    listener.skipMeasures = listener.interval>0? listener.interval  / resource.interval : 0;
                    listener.skipCurrent  = listener.interval>0? listener.interval  / resource.interval : 0;
                }
            }

            // initialize websocket in new connection
            if(!device.wss || device.wss.readyState === device.wss.CLOSING || device.wss.readyState === device.wss.CLOSED) {
                device.wss = getDeviceWebsocket(device.id);
                // create/update stream subscription
            }else if(currentInterval!==resource.interval){
                controlDeviceResource(device.id, {
                    resource: resource.id,
                    interval: Number(resource.interval),
                    enabled: true
                });
            }
        }else{
            controlDeviceResource(device.id, {
                resource: resource.id,
                enabled: false
            });
        }
    }

    function gcd(arr){
        let i, y,
            n = arr.length,
            x = Math.abs(arr[0]);

        for (i = 1; i < n; i++) {
            y = Math.abs(arr[i]);
            while (x && y) {
                (x > y) ? x %= y : y %= x;
            }
            x += y;
        }
        return x;
    }

    function getDeviceResourceInterval(device, resource){
        let intervals = [];
        for(let id in resource.listeners){
            let listener = resource.listeners[id];
            intervals.push(listener.interval);
        }
        let result =  intervals.length!==0 ? gcd(intervals) : 0;
        node.log("Computing intervals for " + device.id + "[" + resource.id + "] with: " + JSON.stringify(intervals) + " -> " + result);
        return result;
    }

    function controlDeviceResource(deviceId, control){
        let device = devices[deviceId];
        if(device === undefined) return;
        node.log(">> Sending to " + deviceId + ": " + JSON.stringify(control));
        device.wss.send(JSON.stringify(control));
    }

    function getDeviceWebsocket(deviceId){
        const url = (config.ssl ? 'wss://' : "ws://") + config.host + "/v3/users/" + config.username + "/devices/" + deviceId + "/resources?authorization=" + token;

        node.log("opening websocket to " + url);

        let wss = new WebSocket(url);

        wss.on('error', function(e){
            console.error("websocket failed");
            console.error(e);

            // get current device
            let device = devices[deviceId];
            if(device === undefined) return;

            for(let resource_name in device.resources){
                // mark listeners as connected
                let resource = device.resources[resource_name];
                for(let id in resource.listeners) {
                    let listener = resource.listeners[id];
                    listener.node.status({fill:"red", shape:"ring", text: 'disconnected'});
                }
            }

            wss.close();
        });

        wss.on('open', function open() {
            // get current device
            let device = devices[deviceId];
            if(device === undefined) return;

            for(let resource_name in device.resources){
                // mark listeners as connected
                let resource = device.resources[resource_name];
                for(let id in resource.listeners) {
                    let listener = resource.listeners[id];
                    listener.node.status({fill:"green",shape:"dot",text:"connected"});
                }
                // control resource
                controlDeviceResource(deviceId, {
                    resource: resource_name,
                    interval: Number(resource.interval),
                    enabled: true
                });
            }
        });

        wss.on('message', function incoming(data) {
            //node.log("<< Received from " + deviceId + ": " + data);

            // get current device
            let device = devices[deviceId];
            if(device === undefined) return;

            // parse incoming data
            let payload = JSON.parse(data);

            // get resource
            let resource = device.resources[payload.resource];

            // no listeners for this resource?
            if(resource === undefined) return;

            for(let id in resource.listeners) {
                let listener = resource.listeners[id];
                if(listener.skipMeasures){
                    node.log("Listener " + id + ": SkipMeasures(" + listener.skipMeasures + ") SkipCurrent (" + listener.skipCurrent + ")");
                    if(listener.skipCurrent===listener.skipMeasures){
                        listener.skipCurrent = 1;
                    }else{
                        listener.skipCurrent++;
                        continue;
                    }
                }
                listener.node.status({fill:"blue",shape:"dot",text:"connected"});
                listener.node.send({payload: payload.out ? payload.out : payload.in});
                listener.node.status({fill:"green",shape:"dot",text:"connected"});
            }
        });

        wss.on('close', function close() {
            // get current device
            let device = devices[deviceId];
            if(device === undefined) return;
            for(let resource_name in device.resources){
                // mark listeners as connected
                let resource = device.resources[resource_name];
                for(let id in resource.listeners) {
                    let listener = resource.listeners[id];
                    listener.node.status({fill:"red",shape:"ring",text:"disconnected"});
                }
            }
        });

        return wss;
    }

    RED.nodes.registerType("thinger-server", ThingerServerNode, {
        credentials: {
            token: {type: "text"}
        }
    });
};