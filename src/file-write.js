module.exports = function(RED) {
    const fs   = require("fs");
    const path = require("path");

    function FileWriteNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic    = config.dynamic;
        this.action     = config.action;
        this.target     = config.target;
        this.targetType = config.targetType || "str";
        this.data       = config.data || "payload";
        this.dataType   = config.dataType || "msg";
        this.createDir  = config.createDir;

        var node = this;

        node.on("input", function(msg, send, done) {
            try {
                const currentAction = node.dynamic ? (msg.file && msg.file.action) : node.action;
                const targetPathRaw = node.dynamic ? (msg.file && msg.file.path) : RED.util.evaluateNodeProperty(node.target, node.targetType, node, msg);
                const fileData      = node.dynamic ? (msg.file && msg.file.data) : RED.util.evaluateNodeProperty(node.data, node.dataType, node, msg);

                if (!targetPathRaw)
                    throw new Error("Target path is missing");

                if (!currentAction)
                    throw new Error("Action is missing");

                if (fileData === undefined)
                    throw new Error("Data to write is undefined");

                const targetPath = path.normalize(targetPathRaw);
                const parsed     = path.parse(targetPath);

                if (node.createDir) {
                    const destDir = path.dirname(targetPath);
                    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                }

                let dataBuffer = fileData;
                if (typeof fileData === "object" && !Buffer.isBuffer(fileData))
                    dataBuffer = JSON.stringify(fileData);

                var file = {
                    filetype : "file",
                    path     : targetPath,
                    dir      : parsed.dir,
                    name     : parsed.name,
                    base     : parsed.base,
                    ext      : parsed.ext
                };

                switch(currentAction) {
                    case "append":
                        fs.appendFile(targetPath, dataBuffer, (err) => {
                            if (err) return handleError(err);
                            msg.file = { ...msg.file, ...file };
                            finishAction(`Appended ${file.base}`);
                        });
                        break;

                    case "write":
                        fs.writeFile(targetPath, dataBuffer, (err) => {
                            if (err) return handleError(err);
                            msg.file = { ...msg.file, ...file };
                            finishAction(`Wrote ${file.base}`);
                        });
                        break;

                    default:
                        throw new Error(`Unknown action type: ${currentAction}`);
                }

                function finishAction(statusText) {
                    node.status({fill: "green", shape: "dot", text: statusText});
                    send(msg);
                    if (done) done();
                    setTimeout(() => node.status({}), 5000);
                }

                function handleError(err) {
                    node.status({fill: "red", shape: "dot", text: err.code || "Error"});
                    if (done) done(err);
                    else node.error(err, msg);
                }
            } catch (err) {
                node.status({fill: "red", shape: "dot", text: "Configuration error"});
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType("file-write", FileWriteNode);
}