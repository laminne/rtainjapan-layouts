import {URLSearchParams} from 'url';
import path from 'path';
import axios from 'axios';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import loadJsonFile from 'load-json-file';
import writeJsonFile from 'write-json-file';
import {NodeCG} from '../../types/nodecg';
import {Twitter} from '../../types/schemas/twitter';
import {Tweets} from '../../types/schemas/tweets';
import {IncomingMessage} from 'http';
import delay from 'delay';

interface Token {
	token: string;
	secret: string;
}

const REQUEST_TOKEN_URL = 'https://api.twitter.com/oauth/request_token';
const ACCESS_TOKEN_URL = 'https://api.twitter.com/oauth/access_token';
const VERIFY_CREDENTIALS_URL =
	'https://api.twitter.com/1.1/account/verify_credentials.json';
const STATUSES_FILTER_URL =
	'https://stream.twitter.com/1.1/statuses/filter.json';

const accessTokenPath = path.resolve(
	__dirname,
	'./db/twitter-access-token.json'
);
const loadAccessToken = async () => {
	const accessToken: Token = await loadJsonFile(accessTokenPath);
	if (
		!accessToken ||
		typeof accessToken.token !== 'string' ||
		typeof accessToken.secret !== 'string'
	) {
		throw new Error('Invalid Twitter access token loaded from DB');
	}
	return accessToken;
};
const saveAccessToken = async ({token, secret}: Token) => {
	return writeJsonFile(accessTokenPath, {token, secret});
};

let requestToken = {
	token: '',
	secret: '',
};

let twitterStream: IncomingMessage | null = null;

export const twitter = async (nodecg: NodeCG) => {
	// prettier-ignore
	const callbackUrl = `http://${nodecg.config.baseURL}/bundles/${nodecg.bundleName}/twitter-callback/index.html`;

	const twitterRep = nodecg.Replicant<Twitter>('twitter');
	const tweetsRep = nodecg.Replicant<Tweets>('tweets', {defaultValue: []});
	const twitterConfig = nodecg.bundleConfig.twitter;
	const {maxTweets} = nodecg.bundleConfig.twitter;

	const oauth = new OAuth({
		consumer: {
			key: twitterConfig.consumerKey,
			secret: twitterConfig.consumerSecret,
		},
		/* eslint-disable camelcase */
		signature_method: 'HMAC-SHA1',
		hash_function(baseString, key) {
			return crypto
				.createHmac('sha1', key)
				.update(baseString)
				.digest('base64');
		},
		/* eslint-enable camelcase */
		realm: '',
	});

	nodecg.listenFor('twitter:startLogin', async (_, cb) => {
		if (cb.handled) {
			return;
		}

		try {
			requestToken = await getRequestToken();
			cb(
				null,
				// prettier-ignore
				`https://api.twitter.com/oauth/authenticate?oauth_token=${requestToken.token}`
			);
		} catch (err) {
			nodecg.log.error('Failed to get Twitter oauth token');
			nodecg.log.error(err);
			cb(err);
		}
	});

	nodecg.listenFor('twitter:loginSuccess', async (data: any) => {
		if (data.oauthToken !== requestToken.token) {
			return;
		}

		try {
			const accessToken = await getAccessToken(data.oauthVerifier);
			await saveAccessToken(accessToken);
			twitterRep.value.userObject = await verifyCredentials();
		} catch (err) {
			nodecg.log.error('Failed to authenticate user');
			nodecg.log.error(err);
		}
	});

	nodecg.listenFor('twitter:logout', async () => {
		twitterRep.value.userObject = null;
		await saveAccessToken({token: '', secret: ''});
	});

	nodecg.listenFor('selectTweet', (id: string) => {
		nodecg.sendMessage('showTweet', deleteTweetById(id));
	});

	nodecg.listenFor('discardTweet', deleteTweetById);

	try {
		await loadAccessToken();
	} catch (_) {
		await saveAccessToken({token: '', secret: ''});
	}

	twitterRep.on('change', async newVal => {
		if (newVal && newVal.userObject) {
			await startFilterStream();
			return;
		}
		if (twitterStream) {
			twitterStream.destroy();
		}
	});

	tweetsRep.on('change', newVal => {
		if (newVal.length <= maxTweets) {
			return;
		}
		tweetsRep.value = tweetsRep.value.slice(0, maxTweets);
	});

	function deleteTweetById(id: string) {
		const selectedTweetIndex = tweetsRep.value.findIndex(t => t.id === id);
		if (selectedTweetIndex === -1) {
			return;
		}
		const tweet = tweetsRep.value[selectedTweetIndex];
		tweetsRep.value.splice(selectedTweetIndex, 1);
		return tweet;
	}

	async function getRequestToken() {
		const oauthData = oauth.authorize({
			url: REQUEST_TOKEN_URL,
			method: 'POST',
			data: {
				/* eslint-disable-next-line camelcase */
				oauth_callback: callbackUrl,
			},
		});
		const res = await axios.post(REQUEST_TOKEN_URL, undefined, {
			headers: oauth.toHeader(oauthData),
		});
		const requestTokenParams = new URLSearchParams(res.data);
		return {
			token: requestTokenParams.get('oauth_token') || '',
			secret: requestTokenParams.get('oauth_token_secret') || '',
		};
	}

	async function getAccessToken(oauthVerifier: string) {
		/* eslint-disable-next-line camelcase */
		const data = {oauth_verifier: oauthVerifier};
		const oauthData = oauth.authorize(
			{
				url: ACCESS_TOKEN_URL,
				method: 'POST',
				data,
			},
			{
				key: requestToken.token,
				secret: requestToken.token,
			}
		);
		const res = await axios.post(ACCESS_TOKEN_URL, data, {
			headers: oauth.toHeader(oauthData),
		});
		const accessTokenParams = new URLSearchParams(res.data);
		return {
			token: accessTokenParams.get('oauth_token') || '',
			secret: accessTokenParams.get('oauth_token_secret') || '',
		};
	}

	async function verifyCredentials() {
		const accessToken = await loadAccessToken();
		const oauthData = oauth.authorize(
			{
				url: VERIFY_CREDENTIALS_URL,
				method: 'GET',
			},
			{key: accessToken.token, secret: accessToken.secret}
		);
		const res = await axios.get(VERIFY_CREDENTIALS_URL, {
			headers: oauth.toHeader(oauthData),
		});
		return res.data;
	}

	async function startFilterStream() {
		try {
			const accessToken = await loadAccessToken();
			if (!accessToken.token || !accessToken.secret) {
				return;
			}
			const data = {
				track: nodecg.bundleConfig.twitter.targetWords.join(','),
			};
			const oauthData = oauth.authorize(
				{
					url: STATUSES_FILTER_URL,
					method: 'POST',
					data,
				},
				{key: accessToken.token, secret: accessToken.secret}
			);

			const res = await axios.post<IncomingMessage>(
				STATUSES_FILTER_URL,
				undefined,
				{
					responseType: 'stream',
					headers: oauth.toHeader(oauthData),
					params: data,
				}
			);
			twitterStream = res.data;
			twitterStream.setEncoding('utf8');
		} catch (err) {
			if (err && err.response && err.response.status === 420) {
				nodecg.log.warn(
					'Failed to start stream API due to rate limit. Retrying in 1 minute.'
				);
				await delay(60 * 1000);
				await startFilterStream();
			} else {
				nodecg.log.error('Failed to start stream API');
				nodecg.log.error(err.message);
			}
			return;
		}

		// Tweets are split when coming in through stream API
		// Store the strings until it can be parsed or gets too long
		let store = '';
		twitterStream.on('data', async (data: any) => {
			if (!data || typeof data !== 'string') {
				return;
			}
			try {
				// Try to parse the string
				store += data;
				const tweetObject = JSON.parse(store);

				// At this point the string could be parsed as JSON
				// So it's safe to clear temporary string and move on
				store = '';

				// Exclude replies, quotes, retweets
				if (
					tweetObject.in_reply_to_user_id_str ||
					tweetObject.quoted_status_id_str ||
					tweetObject.retweeted_status
				) {
					return;
				}

				// Store only necessary data
				const tweet = {
					id: tweetObject.id_str,
					createdAt: new Date(tweetObject.created_at).toISOString(),
					text: tweetObject.text,
					user: {
						name: tweetObject.user.name,
						screenName: tweetObject.user.screen_name,
						profileImageUrl: new URL(
							tweetObject.user.profile_image_url_https
						).toString(),
					},
				};
				tweetsRep.value = [tweet, ...tweetsRep.value];
			} catch (err) {
				if (err.message !== 'Unexpected end of JSON input') {
					nodecg.log.error(err);
					return;
				}
				if (store.length > 100000) {
					store = '';
				}
			}
		});
	}
};
