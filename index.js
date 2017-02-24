"use strict";

const app = require('express')();
const request = require('request');
const WebSocket = require('ws');

const url = 'http://localhost:7000';
const RNG_URL = 'localhost:8080';
const XP_DURATION = 5;
const RNG_ID = 1;
const j = request.jar();

let results;
let ws = null;
let queueId = null;
let xpId = 2;
let userId = null;

function resetResults() {
	results = {
		date : Date.now(),
		trials : []
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
		setTimeout(stopExperiment, XP_DURATION * 1000);
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
		results.trials.push(trialRes);
	});
}

function startExperiment() {
	if(queueId == null) {
		console.log('No queueId');
		return;
	}
	request.post(`${url}/queue/start/${queueId}.json`, {jar: j}, (err, httpResponse, body) => {
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
		queueId = null;
		request.post(`${url}/xp/send_results/${xpId}`, {jar: j, form: {results: JSON.stringify(results), rng_id: RNG_ID, rng_control_user_id: userId}}, (err, httpResponse, body) => {
			// TODO : RESULT ARE SENDED TWO TIMES !!
			console.log('Results sended');
			userId = null;
		});
	});

}

function addToQueue() {
	// TODO : gérer le fait qu'on puisse déjà être dans la queue
	request.post(`${url}/queue/add/${xpId}.json`, {jar: j}, (err, httpResponse, body) => {
		const queue = JSON.parse(body);
		console.log('Added to queue', queue);
		if (queue.item) {
			queueId = queue.item.id;
			if (queue.state.length === 1) {
				console.log('Start experiment');
				startExperiment();
			}
		}
	});
}

app.post('/rng-control', (req, res) => {
	xpId = 2//req.params['xp_id'];
	userId = 1; //req.params['user_id'];


	console.log('Recieve post request', req.params);
	addToQueue();
	// request.get(`${url}/queue/state.json`, (err, httpResponse, body) => {

	// });
	res.send('OK');
});

console.log('Log in to ChichenRand server as control@chickenrand.org');
request.post(`${url}/user/login` , {jar: j, form: {email: 'control@chickenrand.org', password: 'toto'}}, (err, httpResponse, body) => {
	console.log('Cool', j.getCookieString(url));
});


app.listen(1337, () => {
	console.log('Start server on port 1337');
})