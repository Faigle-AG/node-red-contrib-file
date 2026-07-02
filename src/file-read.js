module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');

    function FileReadNode(config) {
        RED.nodes.createNode(this, config);
        this.dynamic = config.dynamic;
        this.actionRead = config.actionRead;
        this.actionExists = config.actionExists;
        this.actionStat = config.actionStat;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';

        var node = this;

        node.on('input', function (msg, send, done) {
            try {
                let sourcePathRaw;
                let runRead;
                let runExists;
                let runStat;

                if (node.dynamic) {
                    if (!msg.file || !msg.file.action)
                        throw new Error('Dynamic action requested but msg.file.action is missing');
                    if (!msg.file || !msg.file.path)
                        throw new Error('Dynamic action requested but msg.file.path is missing');

                    sourcePathRaw = msg.file.path;

                    const act = msg.file.action;
                    if (Array.isArray(act)) {
                        runRead = act.includes('read');
                        runExists = act.includes('exists');
                        runStat = act.includes('stat');
                    } else if (typeof act === 'string') {
                        const actLower = act.toLowerCase();
                        runRead = actLower.includes('read');
                        runExists = actLower.includes('exists');
                        runStat = actLower.includes('stat');
                    } else if (typeof act === 'object') {
                        runRead = !!act.read;
                        runExists = !!act.exists;
                        runStat = !!act.stat;
                    }
                } else {
                    sourcePathRaw = RED.util.evaluateNodeProperty(
                        node.source,
                        node.sourceType,
                        node,
                        msg,
                    );
                    runRead = node.actionRead;
                    runExists = node.actionExists;
                    runStat = node.actionStat;
                }

                if (!sourcePathRaw) throw new Error('Source path is missing');
                if (typeof sourcePathRaw !== 'string')
                    throw new Error('Source path must resolve to a string');

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

                let acts = [];
                if (runRead) {
                    file.data = fs.readFileSync(filename);
                    acts.push('Read');
                }

                if (runExists) {
                    file.exists = fs.existsSync(filename);
                    acts.push(file.exists ? 'Exists' : 'Not Found');
                }

                if (runStat) {
                    file.stats = fs.statSync(filename);
                    acts.push('Stat');
                }

                msg.file = { ...msg.file, ...file };
                node.status({ fill: 'green', shape: 'dot', text: acts.join(', ') });
                send(msg);

                if (done) done();
                setTimeout(() => node.status({}), 5000);
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: err.code || 'Configuration error' });
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('file-read', FileReadNode);
};
