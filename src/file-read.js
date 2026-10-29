module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    // Codes added to previously uncoded errors keep their message as status text,
    // so Status-node consumers see the same text as before.
    function createError(message, code) {
        const err = new Error(message);
        err.code = code;
        Object.defineProperty(err, 'statusText', { value: message });
        return err;
    }

    function FileReadNode(config) {
        RED.nodes.createNode(this, config);
        this.dynamic = config.dynamic;
        this.actionRead = config.actionRead;
        this.actionExists = config.actionExists;
        this.actionStat = config.actionStat;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.target = config.target || 'file';
        this.targetType = config.targetType || 'msg';

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                let sourcePathRaw;
                let runRead;
                let runExists;
                let runStat;

                if (node.dynamic) {
                    if (!msg.file || !msg.file.action)
                        throw createError(
                            'Dynamic action requested but msg.file.action is missing',
                            'ACTION_MISSING',
                        );
                    if (!msg.file || !msg.file.path)
                        throw createError(
                            'Dynamic action requested but msg.file.path is missing',
                            'SOURCE_PATH_MISSING',
                        );

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
                    sourcePathRaw = await node.getTypedProperty(node.source, node.sourceType, msg);
                    runRead = node.actionRead;
                    runExists = node.actionExists;
                    runStat = node.actionStat;
                }

                if (!sourcePathRaw)
                    throw createError('Source path is missing', 'SOURCE_PATH_MISSING');
                if (typeof sourcePathRaw !== 'string')
                    throw createError('Source path must resolve to a string', 'INVALID_PATH');

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

                let currentTargetValue =
                    (await node.getTypedProperty(node.target, node.targetType, msg)) || {};
                await node.setTypedProperty(node.target, node.targetType, msg, {
                    ...currentTargetValue,
                    ...file,
                });

                if (acts.length > 0) node.status.succeeded(acts.join(', '));
                else node.status.info('Did nothing to the file...');

                send(msg);

                if (done) done();
            } catch (err) {
                node.status.failed(
                    err.statusText || err.code || err.message || 'Configuration error',
                );
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('file-read', FileReadNode);
};
