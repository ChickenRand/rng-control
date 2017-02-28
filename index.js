"use strict";

const app = require('express')();
const request = require('request');
const WebSocket = require('ws');

const url = process.env.CHICKENRAND_URL || 'http://localhost:7000';
const RNG_URL = process.env.RNG_URL || 'localhost:8080';
const XP_DURATION = 10;
const RNG_ID = 1;
const j = request.jar();

let results;
let ws = null;
let queueId = null;
let xpId = 2;
let userId = null;
let totalBits = 0;
let trialsCount = 0;

function resetResults() {
	results = {
		date : Date.now(),
		trials : [],
		rng_control: true
	};
}

function bitAt(byte, pos){
	return ((byte & (1 << pos)) !== 0);
};

function connectingRng() {
	console.log('Connecting to RNG');
	ws = new WebSocket(`ws://${RNG_URL}`);

	ws.on('open', () => {
		console.log('Connection with the RNG established');
		resetResults();
		trialsCount = 0;
	});

	ws.on('message', (data, flags) => {
		var trialRes = {
			numbers: Array.from(new Uint8Array(data)),
			nbOnes: 0,
			nbZeros: 0,
			ms: Date.now() - results.date
		};
		for(var i = 0; i < trialRes.numbers.length; i++){
			for(var pos = 0; pos < 8; pos++){
				bitAt(trialRes.numbers[i], pos) ? trialRes.nbOnes++ : trialRes.nbZeros++;
			}
		}
		totalBits += trialRes.nbOnes + trialRes.nbZeros;
		results.trials.push(trialRes);

		trialsCount++;
		// We recieve the message each 100ms
		if(trialsCount > XP_DURATION * 10) {
			stopExperiment();
		}
	});
}

function startExperiment() {
	if(queueId == null) {
		console.log('No queueId');
		return;
	}
	request.post(`${url}/queue/start/${queueId}.json`, {jar: j}, (err, httpResponse, body) => {
		if (err) {
			console.error('Error when starting the experiment.');
			console.error(err);
		}
		const resp = JSON.parse(body);
		if (resp.message != null) {
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
	request.post(`${url}/queue/remove/${queueId}.json`, {jar: j}, (err, httpResponse, body) => {
		if (err) {
			console.error('Error when leaving the queue.');
			console.error(err);
		}
		queueId = null;
		request.post(`${url}/xp/send_results/${xpId}`, {jar: j, form: {results: JSON.stringify(results), rng_id: RNG_ID, rng_control_user_id: userId}}, (err, httpResponse, body) => {
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
	request.post(`${url}/queue/add/${xpId}.json`, {jar: j}, (err, httpResponse, body) => {
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
request.post(`${url}/user/login` , {jar: j, form: {email: 'control@chickenrand.org', password: 'toto'}}, (err, httpResponse, body) => {
	if (err) {
		console.error('Cannot log into chickenrand, exiting.');
		console.error(err);
		process.exit(1);
	}
	console.log('Logged into chickenrand, waiting for control results to generate...');
});


app.listen(1337, () => {
	console.log('Start server on port 1337');
})