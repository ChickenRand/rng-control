'use strict';

const app = require('express')();
const request = require('request');
const WebSocket = require('ws');

const CHICKENRAND_URL = process.env.CHICKENRAND_URL || 'http://localhost:7000';
const CONTROL_PASSWORD = process.env.CONTROL_PASSWORD || 'toto';
const RNG_URL = process.env.RNG_URL || 'localhost:8080';

const NB_TRIALS_PER_SECOND = 10; // We recieve the message each 100ms
const QUEUE_UPDATE_INTERVAL = 3000; // in ms
const RNG_CONTROL_PORT = process.env.PORT || 1337;
const RNG_ID = 2; // TODO : use rng rest API
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
let pendingControls = [];

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
		// TEMP : do not store numbers it takes too much space and cpu and we don't need them for now
		const numbers = Array.from(new Uint8Array(data))
		const trialRes = {
			nbOnes: 0,
			nbZeros: 0,
			ms: Date.now() - results.date
		};
		numbers.forEach(num => {
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
		if (trialsCount >= XP_TRIALS) {
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
	} else {
		// We may have ws message still coming after closing
		return;
	}
	request.post(`${CHICKENRAND_URL}/queue/remove/${queueId}.json`, {jar: COOKIE_JAR}, (err, httpResponse) => {
		if (err) {
			console.error('Error when leaving the queue.');
			console.error(err);
		}
		queueId = null;
		request.post(`${CHICKENRAND_URL}/xp/send_results/${xpId}`, {jar: COOKIE_JAR, form: {results: JSON.stringify(results), rng_id: RNG_ID, rng_control_user_id: userId}}, err => {
			let pending;
			if (err || httpResponse.statusCode === 500) {
				console.error('Error when sending experiment results.');
				console.error(err);
			} else {
				console.log('Results sended total bits recieved : ', totalBits);
			}

			totalBits = 0;
			userId = null;
			// If there is some pending control then launch another control right away
			if (pendingControls.length > 0) {
				pending = pendingControls.pop();
				xpId = pending.xpId;
				userId = pending.userId;
				addToQueue();
			}
		});
	});

}

function update() {
	request.post(`${CHICKENRAND_URL}/queue/update/${queueId}.json`, function (err, httpResponse, body) {
		if (err) {
			console.error('Error when updating the queue');
			console.error(err);
		}
		const data = JSON.parse(body);

		if (data.item_on_top === queueId) {
			startExperiment();
		} else {
			setTimeout(update, QUEUE_UPDATE_INTERVAL);
		}
	});
}

function addToQueue() {
	request.post(`${CHICKENRAND_URL}/queue/add/${xpId}.json`, {jar: COOKIE_JAR}, (err, httpResponse, body) => {
		if (err) {
			console.error('Error when entering into to the queue.');
			console.error(err);
			logIn(addToQueue);
		}
		const queue = JSON.parse(body);
		if (queue.item) {
			console.log('Added to queue : ', queue.item.id);
			queueId = queue.item.id;
			if (queue.state.length === 1) {
				console.log('Start experiment');
				startExperiment();
			} else {
				console.log('Queue is not empty waiting in the queue', queue.state.length);
				update();
			}
		} else {
			console.error('Error when entering into to the queue.');
			console.error(queue.message);
			logIn(addToQueue);
		}
	});
}

function createControlXp(req, res) {
	xpId = req.query['xp_id'];
	userId = req.query['user_id'];

	// We may already be in the queue
	if (!queueId) {
		addToQueue();
	} else {
		pendingControls.push({xpId, userId});
	}

	res.send('OK');
}

function logIn(callback) {
	console.log('Log in to ChichenRand server as control@chickenrand.org');
	request.post(`${CHICKENRAND_URL}/user/login`, {jar: COOKIE_JAR, form: {email: 'control@chickenrand.org', password: CONTROL_PASSWORD}}, err => {
		if (err) {
			console.error('Cannot log into chickenrand, exiting.');
			throw new Error(err);
		}
		console.log('Logged into chickenrand, waiting for control results to generate...');
		if (callback) {
			callback();
		}
	});
}

logIn();

// TODO : Change this GET method to a POST method. Don't know why but I can't get POST params....
app.get('/rng-control', createControlXp);



app.listen(RNG_CONTROL_PORT, () => {
	console.log(`Start server on port ${RNG_CONTROL_PORT}`);
});
