# rng-control
Simple webserver that start control test and deals with the RNG

In order to have the same amount of control data than with active experiment, we need to have a server that mimic an active experiment
and send data to the server.

## How does it works

After someone did an experiment on the website. The server send a POST request to `rng-control` (like `/rng_control`) that take the
 amount of random bits needed and the id of the user who just done the xp.
 
 
It then, enter in the rng queue, and when the rng is available, start an experiment and recieve numbers. When the amount of bits is 
reached, it closes the rng connection and send the data to the serveur with a specific id or comments (I don't know) that specify 
it was a control xp.
