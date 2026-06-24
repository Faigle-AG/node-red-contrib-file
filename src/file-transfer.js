module.exports = function(RED) {
    const fs   = require("fs");
    const path = require("path");

    function FileTransferNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic         = config.dynamic;
        this.action          = config.action;
        this.source          = config.source;
        this.sourceType      = config.sourceType || "str";
        this.destination     = config.destination;
        this.destinationType = config.destinationType || "str";
        this.createDir       = config.createDir;

        var node = this;

        node.on("input", function(msg, send, done) {
            try {
                const currentAction = node.dynamic ? (msg.file && msg.file.action) : node.action;
                const srcRaw        = node.dynamic ? (msg.file && msg.file.source) : RED.util.evaluateNodeProperty(node.source, node.sourceType, node, msg);
                const destRaw       = node.dynamic ? (msg.file && msg.file.destination) : RED.util.evaluateNodeProperty(node.destination, node.destinationType, node, msg);

                if (!currentAction)
                    throw new Error("Action is missing");

                if (!srcRaw)
                    throw new Error("Source path is missing");

                const srcPath = path.normalize(srcRaw);
                let destPath  = null;
                let parsed    = null;

                if (currentAction !== "delete") {
                    if (!destRaw) throw new Error("Destination path is missing");

                    destPath = path.normalize(destRaw);

                    if (srcPath === destPath) {
                        finishAction("Source and Destination are identical", srcPath, destPath);
                        return;
                    }

                    if (node.createDir) {
                        const destDir = path.dirname(destPath);
                        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                    }

                    parsed = path.parse(destPath);
                } else {
                    parsed = path.parse(srcPath);
                }

                var file = {
                    filetype    : "file",
                    action      : currentAction,
                    source      : srcPath,
                    destination : destPath,
                    path        : destPath || srcPath,
                    dir         : parsed.dir,
                    name        : parsed.name,
                    base        : parsed.base,
                    ext         : parsed.ext
                };

                switch(currentAction) {
                    case "copy":
                        fs.copyFile(srcPath, destPath, (err) => {
                            if (err) return handleError(err);

                            msg.file = { ...msg.file, ...file };
                            finishAction(`Copied ${file.base}`, srcPath, destPath);
                        });
                        break;

                    case "move":
                        fs.rename(srcPath, destPath, (err) => {
                            if (err && err.code === 'EXDEV') {
                                fs.copyFile(srcPath, destPath, (copyErr) => {
                                    if (copyErr) return handleError(copyErr);
                                    fs.unlink(srcPath, (unlinkErr) => {
                                        if (unlinkErr) return handleError(unlinkErr);

                                        msg.file = { ...msg.file, ...file };
                                        finishAction(`Moved ${file.base}`, srcPath, destPath);
                                    });
                                });
                            } else if (err) {
                                return handleError(err);
                            } else {
                                msg.file = { ...msg.file, ...file };
                                finishAction(`Moved ${file.base}`, srcPath, destPath);
                            }
                        });
                        break;

                    case "delete":
                        if (destRaw) node.log(`Destination Path ${destPath} will be ignored`);

                        fs.unlink(srcPath, (err) => {
                            if (err) return handleError(err);

                            msg.file = { ...msg.file, ...file };
                            msg.payload = true;
                            finishAction(`Deleted ${file.base}`, srcPath, null);
                        });
                        break;

                    default:
                        throw new Error(`Unknown action type: ${currentAction}`);
                }

                function finishAction(statusText, sPath, dPath) {
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

    RED.nodes.registerType("file-transfer", FileTransferNode);
}