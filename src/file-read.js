module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');

    function FileReadNode(config) {
        RED.nodes.createNode(this, config);
        this.dynamic = config.dynamic;
        this.action = config.action;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';

        var node = this;

        node.on('input', function (msg, send, done) {
            try {
                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const sourcePathRaw = node.dynamic
                    ? msg.file && msg.file.path
                    : RED.util.evaluateNodeProperty(node.source, node.sourceType, node, msg);

                if (!sourcePathRaw) throw new Error('Source path is missing');

                if (!currentAction) throw new Error('Action is missing');

                const filename = path.normalize(sourcePathRaw);
                const parsed = path.parse(filename);

                var file = {
                    filetype: 'file',
                    path: filename,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };

                switch (currentAction) {
                    case 'read':
                        fs.readFile(filename, (err, data) => {
                            if (err) return handleError(err);
                            file.data = data;
                            msg.file = { ...msg.file, ...file };
                            finishAction(`Read ${file.base}`);
                        });
                        break;

                    case 'exists':
                        fs.access(filename, fs.constants.F_OK, (err) => {
                            file.exists = !err;
                            msg.file = { ...msg.file, ...file };
                            finishAction(file.exists ? 'Exists' : 'Does not exist');
                        });
                        break;

                    case 'stat':
                        fs.stat(filename, (err, stats) => {
                            if (err) return handleError(err);

                            file.stats = stats;
                            msg.file = { ...msg.file, ...file };
                            finishAction(`Stat ${file.base}`);
                        });
                        break;

                    default:
                        throw new Error(`Unknown action type: ${currentAction}`);
                }

                function finishAction(statusText) {
                    node.status({ fill: 'green', shape: 'dot', text: statusText });
                    send(msg);
                    if (done) done();
                    setTimeout(() => node.status({}), 5000);
                }

                function handleError(err) {
                    node.status({ fill: 'red', shape: 'dot', text: err.code || 'Error' });
                    if (done) done(err);
                    else node.error(err, msg);
                }
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: 'Configuration error' });
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('file-read', FileReadNode);
};
