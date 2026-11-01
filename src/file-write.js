// The types each typed field offers in the editor (Phase 2.9). A configured type outside these
// fails clearly before anything is read or changed.
const TYPES = {
    target: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
    data: ['msg', 'flow', 'global', 'str', 'json', 'bin', 'jsonata', 'env'],
};

module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    function createError(message, code) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    function FileWriteNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic = config.dynamic;
        this.action = config.action;
        this.target = config.target;
        this.targetType = config.targetType || 'str';
        this.data = config.data || 'file.data';
        this.dataType = config.dataType || 'msg';
        this.createDir = config.createDir;

        var node = this;
        extendNode(node);

        // True only when the msg data path provably stops at a missing (undefined/null) parent.
        // Reads own data descriptors, so no getter runs again; inherited, accessor or computed
        // parts are treated as uncertain and leave the original error uncoded.
        function hasMissingParent(msg) {
            try {
                const parts = RED.util.normalisePropertyExpression(
                    String(node.data).replace(/^msg\./, ''),
                );
                let current = msg;
                for (const part of parts.slice(0, -1)) {
                    if (typeof part !== 'string' && typeof part !== 'number') return false;
                    const descriptor = Object.getOwnPropertyDescriptor(current, part);
                    if (!descriptor) return !(part in current);
                    if (!('value' in descriptor)) return false;
                    current = descriptor.value;
                    if (current === undefined || current === null) return true;
                    if (typeof current !== 'object') return false;
                }
                return false;
            } catch {
                return false;
            }
        }

        // A msg data path through a missing parent (e.g. file.data without msg.file) throws a
        // TypeError; tag it DATA_MISSING and keep its message and status text.
        async function getStaticData(msg) {
            try {
                return await node.getTypedProperty(node.data, node.dataType, msg);
            } catch (err) {
                if (
                    node.dataType === 'msg' &&
                    err instanceof TypeError &&
                    !err.code &&
                    hasMissingParent(msg)
                ) {
                    err.code = 'DATA_MISSING';
                }
                throw err;
            }
        }

        // After close, input still in progress starts no new filesystem operation and completes
        // without status, output or error.
        let closing = false;
        node.on('close', function () {
            closing = true;
        });

        node.on('input', async function (msg, send, done) {
            const finishClosed = () => {
                if (done) done();
            };
            try {
                // Dynamic mode ignores the static target and data, so their types are not checked
                // there.
                if (!node.dynamic) {
                    for (const [field, label] of [
                        ['target', 'Target'],
                        ['data', 'Data'],
                    ]) {
                        const type = node[`${field}Type`];
                        if (!TYPES[field].includes(type)) {
                            throw createError(
                                `${label} type '${type}' is not supported`,
                                'INVALID_CONFIGURATION',
                            );
                        }
                    }
                }

                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const targetPathRaw = node.dynamic
                    ? msg.file && msg.file.path
                    : await node.getTypedProperty(node.target, node.targetType, msg);
                const fileData = node.dynamic
                    ? msg.file && msg.file.data
                    : await getStaticData(msg);
                const createDir = node.dynamic ? msg.file && msg.file.createDir : node.createDir;

                // The node may have closed while the target and data were read.
                if (closing) return finishClosed();

                if (!targetPathRaw)
                    throw createError('Target path is missing', 'TARGET_PATH_MISSING');
                if (!currentAction) throw createError('Action is missing', 'ACTION_MISSING');
                if (fileData === undefined)
                    throw createError('Data to write is undefined', 'DATA_MISSING');
                if (currentAction !== 'write' && currentAction !== 'append')
                    throw createError(`Unknown action type: ${currentAction}`, 'INVALID_ACTION');

                const targetPath = path.normalize(targetPathRaw);
                const parsed = path.parse(targetPath);

                if (createDir) {
                    const destDir = path.dirname(targetPath);
                    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                }

                let dataBuffer = fileData;
                if (typeof fileData === 'object' && !Buffer.isBuffer(fileData))
                    dataBuffer = JSON.stringify(fileData);

                var file = {
                    filetype: 'file',
                    path: targetPath,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };

                switch (currentAction) {
                    case 'append':
                        fs.appendFile(targetPath, dataBuffer, (err) => {
                            if (err) return handleError(err);
                            msg.file = { ...msg.file, ...file };
                            finishAction(`Appended ${file.base}`);
                        });
                        break;

                    case 'write':
                        fs.writeFile(targetPath, dataBuffer, (err) => {
                            if (err) return handleError(err);
                            msg.file = { ...msg.file, ...file };
                            finishAction(`Wrote ${file.base}`);
                        });
                        break;
                }

                // The write callbacks may run after close.
                function finishAction(statusText) {
                    if (closing) return finishClosed();
                    node.status.succeeded(statusText);
                    send(msg);
                    if (done) done();
                }

                function handleError(err) {
                    if (closing) return finishClosed();
                    node.status.failed(err.code || 'Error');
                    if (done) done(err);
                    else node.error(err, msg);
                }
            } catch (err) {
                if (closing) return finishClosed();
                node.status.failed('Configuration error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('file-write', FileWriteNode);
};

module.exports.TYPES = TYPES;
