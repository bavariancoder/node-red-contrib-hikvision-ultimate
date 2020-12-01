

module.exports = (RED) => {

    const DigestFetch = require('digest-fetch')
    const AbortController = require('abort-controller');
    const xml2js = require('xml2js').Parser({ explicitArray: false }).parseString;

    function ANPRconfig(config) {
        RED.nodes.createNode(this, config)
        var node = this
        node.host = config.host;
        node.port = config.port;
        node.nodeClients = []; // Stores the registered clients
        node.isConnected = false;
        node.lastPicName = "";
        var controller = null; // Abortcontroller

        node.setAllClientsStatus = ({ fill, shape, text }) => {
            function nextStatus(oClient) {
                oClient.setNodeStatus({ fill: fill, shape: shape, text: text })
            }
            node.nodeClients.map(nextStatus);
        }

        // Function to get the plate list from the camera
        async function getPlates(_lastPicName) {
            if (_lastPicName == undefined || _lastPicName == null || _lastPicName == "") return null;

            const client = new DigestFetch(node.credentials.user, node.credentials.password); // Instantiate the fetch client.
            controller = new AbortController(); // For aborting the stream request
            var options = {
                // These properties are part of the Fetch Standard
                method: 'POST',
                headers: { 'content-type': 'application/xml' },        // request headers. format is the identical to that accepted by the Headers constructor (see below)
                body: "<AfterTime><picTime>" + _lastPicName + "</picTime></AfterTime>",         // request body. can be null, a string, a Buffer, a Blob, or a Node.js Readable stream
                redirect: 'follow', // set to `manual` to extract redirect headers, `error` to reject redirect
                signal: controller.signal,       // pass an instance of AbortSignal to optionally abort requests

                // The following properties are node-fetch extensions
                follow: 20,         // maximum redirect count. 0 to not follow redirect
                timeout: 5000,         // req/res timeout in ms, it resets on redirect. 0 to disable (OS limit applies). Signal is recommended instead.
                compress: false,     // support gzip/deflate content encoding. false to disable
                size: 0,            // maximum response body size in bytes. 0 to disable
                agent: null         // http(s).Agent instance or function that returns an instance (see below)
            };
            try {
                const response = await client.fetch("http://" + node.host + "/ISAPI/Traffic/channels/1/vehicleDetect/plates", options);
                if (response.status >= 200 && response.status <= 300) {
                    node.setAllClientsStatus({ fill: "green", shape: "ring", text: "Connected." });
                } else {
                    node.setAllClientsStatus({ fill: "red", shape: "ring", text: response.statusText });
                    // console.log("BANANA Error response " + response.statusText);
                    throw ("Error response: " + response.statusText);
                }
                //#region "BODY"
                const body = await response.text();
                var sRet = "";
                sRet = body.toString();
                //// console.log("BANANA " + sRet);
                var oPlates = null;
                try {
                    var i = sRet.indexOf("<"); // Get only the XML, starting with "<"
                    if (i > -1) {
                        sRet = sRet.substring(i);
                        // By xml2js
                        xml2js(sRet, function (err, result) {
                            oPlates = result;
                        });
                    } else {
                        i = sRet.indexOf("{") // It's a Json
                        if (i > -1) {
                            sRet = sRet.substring(i);
                            oPlates = JSON.parse(result);
                        } else {
                            // Invalid body
                            RED.log.info("ANPR-config: DecodingBody: Invalid Json " + sRet);
                            // console.log("BANANA ANPR-config: DecodingBody: Invalid Json " + sRet);
                            throw ("Error Invalid Json: " + sRet);
                        }
                    }
                    // console.log("BANANA GIASONE " + JSON.stringify(oPlates));
                    // Working the plates. Must be sure, that no error occurs, before acknolwedging the plate last picName
                    if (oPlates.Plates !== null) {
                        node.setAllClientsStatus({ fill: "green", shape: "ring", text: "Waiting for vehicle..." });
                        if (!node.isConnected) {
                            node.nodeClients.forEach(oClient => {
                                oClient.sendPayload({ topic: oClient.topic || "", payload: null, connected: true });
                            })
                        }
                        node.isConnected = true;
                        return oPlates;
                    } else {
                        // Error in parsing XML
                        throw ("Error: oPlates.Plates is null");
                    }

                } catch (error) {
                    RED.log.error("ANPR-config: ERRORE CATCHATO initPlateReader:" + error);
                    // console.log("BANANA ANPR-config: ERRORE CATCHATO initPlateReader: " + error);
                    throw ("Error initPlateReader: " + error);
                }
                //#endregion 
            } catch (err) {
                // Main Error
                // console.log("BANANA MAIN ERROR: " + err);
                // Abort request
                try {
                    if (controller !== null) controller.abort();
                } catch (error) { }
                node.setAllClientsStatus({ fill: "grey", shape: "ring", text: "Server unreachable: " + err + " Retry..." });
                if (node.isConnected) {
                    node.nodeClients.forEach(oClient => {
                        oClient.sendPayload({ topic: oClient.topic || "", payload: null, connected: false });
                    })
                }
                node.isConnected = false;
                return null;
            };

        };


        // At start, reads the last recognized plate and starts listening from the time last plate was recognized.
        // This avoid output all the previoulsy plate list, stored by the camera.
        node.initPlateReader = () => {
            // console.log("BANANA INITPLATEREADER");
            node.setAllClientsStatus({ fill: "grey", shape: "ring", text: "Getting prev list to be ignored..." });
            (async () => { 
                var oPlates = await getPlates("202001010101010000");
                if (oPlates === null) {
                    setTimeout(node.initPlateReader, 10000); // Restart initPlateReader
                } else {
                    // console.log("BANANA STRIGONE " + JSON.stringify(oPlates))
                    if (oPlates.Plates.hasOwnProperty("Plate") && oPlates.Plates.Plate.length > 0) {
                        try {
                            node.lastPicName = oPlates.Plates.Plate[oPlates.Plates.Plate.length - 1].picName;
                            node.setAllClientsStatus({ fill: "grey", shape: "ring", text: "Found " + oPlates.Plates.Plate.length + " ignored plates. Last was " + node.lastPicName });
                        } catch (error) {
                            // console.log("BANANA Error oPlates.Plates.Plate[oPlates.Plates.Plate.length - 1]: " + error);
                            setTimeout(node.initPlateReader, 10000); // Restart initPlateReader
                            return;
                        }
                    } else {
                        // No previously plates found, set a default datetime
                        node.setAllClientsStatus({ fill: "grey", shape: "ring", text: "No previously plates found." });
                        node.lastPicName = "202001010101010000";
                    }
                    setTimeout(node.queryForPlates, 2000); // Start main polling thread
                }
            })();
        };



        node.queryForPlates = () => {
            // console.log("BANANA queryForPlates");
            if (node.lastPicName === "") {
                // Should not be here!
                node.setAllClientsStatus({ fill: "red", shape: "ring", text: "Cacchio, non dovrei essere qui." });
                if (node.isConnected) {
                    node.nodeClients.forEach(oClient => {
                        oClient.sendPayload({ topic: oClient.topic || "", payload: null, connected: false });
                    })
                }
                node.isConnected = false;
                setTimeout(node.initPlateReader, 10000); // Restart whole process.
            } else {
                (async () => {
                    var oPlates = await getPlates(node.lastPicName);
                    if (oPlates === null) {
                        // An error was occurred.
                        setTimeout(node.initPlateReader, 10000); // Restart initPlateReader from scratch
                    } else {
                        if (oPlates.Plates.hasOwnProperty("Plate") && oPlates.Plates.Plate.length > 0) {
                            // Send the message to the child nodes
                            oPlates.Plates.Plate.forEach(oPlate => {
                                node.nodeClients.forEach(oClient => {
                                    oClient.sendPayload({ topic: oClient.topic || "", plate: oPlate, payload: oPlate.plateNumber, connected: true });
                                })
                            })
                        } else {
                            // No new plates found
                        }
                        setTimeout(node.queryForPlates, 1000); // Call the cunction again.
                    }
                })();
            }
        };

        // Start!
        setTimeout(node.initPlateReader, 10000); // First connection.


        //#region "FUNCTIONS"
        node.on('close', function (removed, done) {
            try {
                controller.abort();
            } catch (error) { }
            done();
        });



        node.addClient = (_Node) => {
            // Check if node already exists
            if (node.nodeClients.filter(x => x.id === _Node.id).length === 0) {
                // Add _Node to the clients array
                node.nodeClients.push(_Node)
            }
            try {
                _Node.setNodeStatus({ fill: "grey", shape: "ring", text: "Waiting for connection" });
            } catch (error) { }
        };

        node.removeClient = (_Node) => {
            // Remove the client node from the clients array
            //RED.log.info( "BEFORE Node " + _Node.id + " has been unsubscribed from receiving KNX messages. " + node.nodeClients.length);
            try {
                node.nodeClients = node.nodeClients.filter(x => x.id !== _Node.id)
            } catch (error) { }
            //RED.log.info("AFTER Node " + _Node.id + " has been unsubscribed from receiving KNX messages. " + node.nodeClients.length);

            // If no clien nodes, disconnect from bus.
            if (node.nodeClients.length === 0) {

            }
        };
        //#endregion
    }


    RED.nodes.registerType("ANPR-config", ANPRconfig, {
        credentials: {
            user: { type: "text" },
            password: { type: "password" }
        }
    });
}