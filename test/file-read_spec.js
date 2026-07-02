const fs = require('fs');
const path = require('path');
const should = require('should');
const helper = require('node-red-node-test-helper');
const fileReadNode = require('../src/file-read.js');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');
const INPUT_FILE = path.join(DATA_DIR, 'file-in');
const INPUT_TEXT = 'DO NOT CHANGE THIS TEXT! IT IS CHECKED IN THE TEST...\n';

function ensureDataFile() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INPUT_FILE, INPUT_TEXT);
}

describe('file-read node', function () {
    beforeEach(function (done) {
        ensureDataFile();
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('loads with configured properties', function (done) {
        const flow = [
            {
                id: 'n1',
                type: 'file-read',
                name: 'read test file',
                dynamic: false,
                actionRead: true,
                actionExists: false,
                actionStat: false,
                source: INPUT_FILE,
                sourceType: 'str',
            },
        ];

        helper.load(fileReadNode, flow, function () {
            const n1 = helper.getNode('n1');
            n1.should.have.property('name', 'read test file');
            n1.should.have.property('actionRead', true);
            n1.should.have.property('source', INPUT_FILE);
            done();
        });
    });

    it('reads a configured file into msg.file.data as a Buffer', function (done) {
        const flow = [
            {
                id: 'n1',
                type: 'file-read',
                dynamic: false,
                actionRead: true,
                actionExists: false,
                actionStat: false,
                source: INPUT_FILE,
                sourceType: 'str',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileReadNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                should(Buffer.isBuffer(msg.file.data)).be.true();
                msg.file.data.toString().should.equal(INPUT_TEXT);
                msg.file.path.should.equal(path.normalize(INPUT_FILE));
                msg.file.base.should.equal('file-in');
                msg.file.name.should.equal('file-in');
                msg.file.ext.should.equal('');
                done();
            });

            n1.receive({ payload: true });
        });
    });

    it('checks whether a configured file exists', function (done) {
        const flow = [
            {
                id: 'n1',
                type: 'file-read',
                actionRead: false,
                actionExists: true,
                actionStat: false,
                source: INPUT_FILE,
                sourceType: 'str',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileReadNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                msg.file.exists.should.equal(true);
                msg.file.path.should.equal(path.normalize(INPUT_FILE));
                done();
            });

            n1.receive({});
        });
    });

    it('checks missing file existence without throwing', function (done) {
        const missing = path.join(DATA_DIR, 'missing-file');
        const flow = [
            {
                id: 'n1',
                type: 'file-read',
                actionRead: false,
                actionExists: true,
                actionStat: false,
                source: missing,
                sourceType: 'str',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileReadNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                msg.file.exists.should.equal(false);
                msg.file.path.should.equal(path.normalize(missing));
                done();
            });

            n1.receive({});
        });
    });

    it('returns fs stats for a configured file', function (done) {
        const flow = [
            {
                id: 'n1',
                type: 'file-read',
                actionRead: false,
                actionExists: false,
                actionStat: true,
                source: INPUT_FILE,
                sourceType: 'str',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileReadNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                msg.file.stats.should.be.Object();
                msg.file.stats.isFile().should.equal(true);
                msg.file.stats.size.should.equal(Buffer.byteLength(INPUT_TEXT));
                done();
            });

            n1.receive({});
        });
    });

    it('reads dynamically from msg.file.action and msg.file.path', function (done) {
        const flow = [
            { id: 'n1', type: 'file-read', dynamic: true, wires: [['h1']] },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileReadNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                msg.file.data.toString().should.equal(INPUT_TEXT);
                msg.file.extra.should.equal('preserved');
                done();
            });

            n1.receive({ file: { action: 'read', path: INPUT_FILE, extra: 'preserved' } });
        });
    });
});
