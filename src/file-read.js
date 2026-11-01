// The types each typed field offers in the editor (Phase 2.9). A configured type outside these
// fails clearly before anything is read or changed.
const TYPES = {
    source: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
    target: ['msg', 'flow', 'global'],
};

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

        // After close, input still in progress starts no new filesystem operation or output write
        // and completes without status, output or error.
        let closing = false;
        node.on('close', function () {
            closing = true;
        });

        node.on('input', async function (msg, send, done) {
            const finishClosed = () => {
                if (done) done();
            };
            try {
                // Dynamic mode ignores the static source, so its type is not checked there.
                if (!node.dynamic && !TYPES.source.includes(node.sourceType)) {
                    throw createError(
                        `Source type '${node.sourceType}' is not supported`,
                        'INVALID_CONFIGURATION',
                    );
                }
                if (!TYPES.target.includes(node.targetType)) {
                    throw new Error(`Unsupported target property type: ${node.targetType}`);
                }

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

                // The node may have closed while the source path was read.
                if (closing) return finishClosed();

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
                if (closing) return finishClosed();
                await node.setTypedProperty(node.target, node.targetType, msg, {
                    ...currentTargetValue,
                    ...file,
                });
                if (closing) return finishClosed();

                if (acts.length > 0) node.status.succeeded(acts.join(', '));
                else node.status.info('Did nothing to the file...');

                send(msg);

                if (done) done();
            } catch (err) {
                if (closing) return finishClosed();
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

module.exports.TYPES = TYPES;
