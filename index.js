'use strict';

const app = require('express')();
const request = require('request');
const WebSocket = require('ws');

const CHICKENRAND_URL = process.env.CHICKENRAND_URL || 'http://localhost:7000';
const CONTROL_PASSWORD = process.env.CONTROL_PASSWORD || 'toto';
const RNG_URL = process.env.RNG_URL || 'localhost:8080';

const NB_TRIALS_PER_SECOND = 10; // We recieve the message each 100ms
const RNG_CONTROL_PORT = 1337;
const RNG_ID = 1; // TODO : use rng rest API
const XP_DURATION = 10; // in seconds
const XP_TRIALS = NB_TRIALS_PER_SECOND * XP_DURATION;

const COOKIE_JAR = request.jar();

let results;
let ws = null;
let queueId = null;
let xpId = 2;
let userId = null;
let totalBits = 0;
let trialsCount = 0;

function resetResults() {
	results = {
		date: Date.now(),
		trials: [],
		rng_control: true
	};
}

function bitAt(byte, pos) {
	return ((byte & (1 << pos)) !== 0);
}

function connectingRng() {
	console.log('Connecting to RNG');
	ws = new WebSocket(`ws://${RNG_URL}`);

	ws.on('open', () => {
		console.log('Connection with the RNG established');
		resetResults();
		trialsCount = 0;
	});

	ws.on('message', data => {
		const NB_BITS_PER_BYTE = 8;
		const trialRes = {
			numbers: Array.from(new Uint8Array(data)),
			nbOnes: 0,
			nbZeros: 0,
			ms: Date.now() - results.date
		};
		trialRes.numbers.forEach(num => {
			for (let pos = 0; pos < NB_BITS_PER_BYTE; pos++) {
				if (bitAt(num, pos)) {
					trialRes.nbOnes++;
				} else {
					trialRes.nbZeros++;
				}
			}
		});
		totalBits += trialRes.nbOnes + trialRes.nbZeros;
		results.trials.push(trialRes);

		trialsCount++;
		if (trialsCount > XP_TRIALS) {
			stopExperiment();
		}
	});
}

function startExperiment() {
	if (queueId === null) {
		console.log('No queueId');
		return;
	}
	request.post(`${CHICKENRAND_URL}/queue/start/${queueId}.json`, {jar: COOKIE_JAR}, (err, httpResponse, body) => {
		if (err) {
			console.error('Error when starting the experiment.');
			console.error(err);
		}
		const resp = JSON.parse(body);
		if (resp.message) {
			console.error('problem');
			return;
		}
		connectingRng();
	});
}

function stopExperiment() {
	if (ws) {
		ws.close();
		ws = null;
	}
	request.post(`${CHICKENRAND_URL}/queue/remove/${queueId}.json`, {jar: COOKIE_JAR}, err => {
		if (err) {
			console.error('Error when leaving the queue.');
			console.error(err);
		}
		queueId = null;
		request.post(`${CHICKENRAND_URL}/xp/send_results/${xpId}`, {jar: COOKIE_JAR, form: {results: JSON.stringify(results), rng_id: RNG_ID, rng_control_user_id: userId}}, err => {
			if (err) {
				console.error('Error when sending experiment results.');
				console.error(err);
			}
			console.log('Results sended total bits recieved : ', totalBits);
			totalBits = 0;
			userId = null;
		});
	});

}

function addToQueue() {
	// TODO : gérer le fait qu'on puisse déjà être dans la queue
	// TODO : gérer la queue avec les states et tout
	request.post(`${CHICKENRAND_URL}/queue/add/${xpId}.json`, {jar: COOKIE_JAR}, (err, httpResponse, body) => {
		if (err) {
			console.error('Error when entering into to the queue.');
			console.error(err);
		}
		const queue = JSON.parse(body);
		if (queue.item) {
			console.log('Added to queue : ', queue.item.id);
			queueId = queue.item.id;
			if (queue.state.length === 1) {
				console.log('Start experiment');
				startExperiment();
			}
		}
	});
}

function createControlXp(req, res) {
	xpId = req.query['xp_id'];
	userId = req.query['user_id'];

	addToQueue();

	res.send('OK');
}

// TODO : Change this GET method to a POST method. Don't know why but I can't get POST params....
app.get('/rng-control', createControlXp);

console.log('Log in to ChichenRand server as control@chickenrand.org');
request.post(`${CHICKENRAND_URL}/user/login`, {jar: COOKIE_JAR, form: {email: 'control@chickenrand.org', password: CONTROL_PASSWORD}}, err => {
	if (err) {
		console.error('Cannot log into chickenrand, exiting.');
		throw new Error(err);
	}
	console.log('Logged into chickenrand, waiting for control results to generate...');
});


app.listen(RNG_CONTROL_PORT, () => {
	console.log(`Start server on port ${RNG_CONTROL_PORT}`);
});
