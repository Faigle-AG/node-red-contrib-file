module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    function createError(message, code) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    function FileTransferNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic = config.dynamic;
        this.action = config.action;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.destination = config.destination;
        this.destinationType = config.destinationType || 'str';
        this.createDir = config.createDir;

        var node = this;
        extendNode(node);

        // After close, input still in progress starts no new filesystem operation and completes
        // without status, output or error; only a cross-device move stopped part-way completes
        // with an error (see below).
        let closing = false;
        node.on('close', function () {
            closing = true;
        });

        node.on('input', async function (msg, send, done) {
            const finishClosed = () => {
                if (done) done();
            };
            try {
                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const srcRaw = node.dynamic
                    ? msg.file && msg.file.source
                    : await node.getTypedProperty(node.source, node.sourceType, msg);
                const destRaw = node.dynamic
                    ? msg.file && msg.file.destination
                    : await node.getTypedProperty(node.destination, node.destinationType, msg);
                const createDir = node.dynamic ? msg.file && msg.file.createDir : node.createDir;

                // The node may have closed while the paths were read.
                if (closing) return finishClosed();

                if (!currentAction) throw createError('Action is missing', 'ACTION_MISSING');
                if (!srcRaw) throw createError('Source path is missing', 'SOURCE_PATH_MISSING');

                const srcPath = path.normalize(srcRaw);
                let destPath = null;
                let parsed = null;

                if (currentAction !== 'delete') {
                    if (!destRaw)
                        throw createError(
                            'Destination path is missing',
                            'DESTINATION_PATH_MISSING',
                        );

                    destPath = path.normalize(destRaw);

                    if (srcPath === destPath) {
                        finishAction('Source and Destination are identical', srcPath, destPath);
                        return;
                    }

                    if (currentAction !== 'copy' && currentAction !== 'move') {
                        throw createError(
                            `Unknown action type: ${currentAction}`,
                            'INVALID_ACTION',
                        );
                    }

                    if (createDir) {
                        const destDir = path.dirname(destPath);
                        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                    }

                    parsed = path.parse(destPath);
                } else parsed = path.parse(srcPath);

                var file = {
                    filetype: 'file',
                    action: currentAction,
                    source: srcPath,
                    destination: destPath,
                    path: destPath || srcPath,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };

                switch (currentAction) {
                    case 'copy':
                        fs.copyFile(srcPath, destPath, (err) => {
                            if (err) return handleError(err);

                            msg.file = { ...msg.file, ...file };
                            finishAction(`Copied ${file.base}`, srcPath, destPath);
                        });
                        break;

                    case 'move':
                        fs.rename(srcPath, destPath, (err) => {
                            if (err && err.code === 'EXDEV') {
                                // A cross-device move copies, then removes the source. After close
                                // it starts no next step and completes with an error, so the move
                                // is not reported as done. The source is kept because its removal
                                // never starts; a copy already made stays.
                                if (closing) return moveStoppedOnClose('before copying');
                                fs.copyFile(srcPath, destPath, (copyErr) => {
                                    if (closing)
                                        return moveStoppedOnClose('after copying', copyErr);
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

                    case 'delete':
                        if (destRaw) node.log(`Destination Path ${destRaw} will be ignored`);

                        fs.unlink(srcPath, (err) => {
                            if (err) return handleError(err);

                            msg.file = { ...msg.file, ...file };
                            msg.payload = true;
                            finishAction(`Deleted ${file.base}`, srcPath, null);
                        });
                        break;
                }

                // A cross-device move stopped by close reports an error (a copy error as itself),
                // without status.
                function moveStoppedOnClose(stage, copyErr) {
                    const err =
                        copyErr ||
                        createError(
                            `Cross-device move stopped on close ${stage}; the source file was kept`,
                            'NODE_CLOSING',
                        );
                    if (done) done(err);
                    else node.error(err, msg);
                }

                // The operation callbacks may run after close.
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

    RED.nodes.registerType('file-transfer', FileTransferNode);
};
