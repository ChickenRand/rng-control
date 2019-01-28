'use strict';

const express = require('express');
const app = express();
const request = require('request');
const WebSocket = require('ws');

const CHICKENRAND_URL = process.env.CHICKENRAND_URL || 'http://localhost:7000';
const CONTROL_PASSWORD = process.env.CONTROL_PASSWORD || 'toto';
const RNG_URL = process.env.RNG_URL || 'localhost:8080';

const NB_TRIALS_PER_SECOND = 10; // We recieve the message each 100ms
const QUEUE_UPDATE_INTERVAL = 3000; // in ms
const TIME_BEFORE_STARTING_XP = 1000; // in ms
const RNG_CONTROL_PORT = process.env.PORT || 1337;
const RNG_ID = process.env.RNG_ID || 2; // TODO : use rng rest API
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
let xpStarted = false;

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
		xpStarted = true;
		setTimeout(() => ws.send('start'), TIME_BEFORE_STARTING_XP);
	});

	ws.on('close', () => {
		if (queueId !== null) {
			console.log('Connection closed. Remove from queue.')
			removeFromQueue()
				.catch(err => console.error('Error when leaving the queue.', err))
				.then(function() {
					let pending;

					// If there is some pending control then launch another control right away
					if (pendingControls.length > 0) {
						pending = pendingControls.pop();
						xpId = pending.xpId;
						userId = pending.userId;
						addToQueue();
					}
				});
		}
	});

	ws.on('message', data => {
		if(!xpStarted) {
			return;
		}
		const NB_BITS_PER_BYTE = 8;
		const numbers = Array.from(new Uint8Array(data))
		const trialRes = {
			nbOnes: 0,
			nbZeros: 0,
			ms: Date.now() - results.date,
			rawDataBase64: Buffer.from(data).toString("base64")
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
		if (trialsCount === XP_TRIALS) {
			stopExperiment();
		}
	});

	ws.on('error', (e) => {
		console.log('RNG connection error. Message :', e.message);
		stopExperiment(true);
	})
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
			console.error('problem', resp.message);
			return;
		}
		connectingRng();
	});
}

function removeFromQueue() {
	return new Promise((resolve, reject) => {
		request.post(`${CHICKENRAND_URL}/queue/remove/${queueId}.json`, {jar: COOKIE_JAR}, (err, httpResponse) => {
			queueId = null;
			if (err) {
				reject(err);
			}
			resolve();
		});
	});
}

function sendResults() {
	return new Promise((resolve, reject) => {
		request.post(`${CHICKENRAND_URL}/xp/send_results/${xpId}`, {jar: COOKIE_JAR, form: {results: JSON.stringify(results), rng_id: RNG_ID, rng_control_user_id: userId}}, (err, httpResponse, body) => {
			if (err || httpResponse.statusCode === 500) {
				reject(err);
			}
			resolve(body)
		});
	});
}

function stopExperiment(err) {
	if (ws) {
		ws.close();
		ws = null;
		xpStarted = false;
	}
	// We may stop the expermiment with no result (ie rng connection error)
	if(err) {
		removeFromQueue()
			.catch(err => console.error('Error when leaving the queue.', err));
	} else {
		sendResults()
			.then(() => {
				console.log('Results sended total bits recieved : ', totalBits);
				totalBits = 0;
				userId = null;
			})
			.catch(err => console.error('Error when sending experiment results.', err));
	}
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
			console.log('Added to queue #', queue.item.id);
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
			//TEMP need a better error handling
			if(queue.message === 'Erreur : Vous devez être connecté.') {
				logIn(addToQueue);
			}
		}
	});
}

function createControlXp(req, res) {
	xpId = req.body['xp_id'];
	userId = req.body['user_id'];

	if(xpId) {
		// We may already be in the queue
		if (queueId === null) {
			addToQueue();
		} else {
			pendingControls.push({xpId, userId});
		}
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

app.use(express.json());
app.post('/rng-control', createControlXp);



app.listen(RNG_CONTROL_PORT, () => {
	console.log(`Start server on port ${RNG_CONTROL_PORT}`);
});
