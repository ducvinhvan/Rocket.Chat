import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { ReactiveVar } from 'meteor/reactive-var';
import { EJSON } from 'meteor/ejson';
import { TAPi18n } from 'meteor/rocketchat:tap-i18n';

import {
	toString,
	toArrayBuffer,
	joinVectorAndEncryptedData,
	splitVectorAndEncryptedData,
	encryptAES,
	decryptAES,
	generateRSAKey,
	exportJWKKey,
	importRSAKey,
	importRawKey,
	deriveKey,
} from './helpers';
import * as banners from '../../../client/lib/banners';
import { Subscriptions, Messages } from '../../models/client';
import './tabbar';
import { imperativeModal } from '../../../client/lib/imperativeModal';
import SaveE2EEPasswordModal from '../../../client/views/e2ee/SaveE2EEPasswordModal';
import EnterE2EEPasswordModal from '../../../client/views/e2ee/EnterE2EEPasswordModal';
import { APIClient } from '../../utils/client';
import { E2EEManager } from './E2EEManager';

let failedToDecodeKey = false;

class E2E extends E2EEManager {
	constructor() {
		super();
		this.started = false;
		this.enabled = new ReactiveVar(false);
		this._ready = new ReactiveVar(false);

		this.on('ready', () => {
			this._ready.set(true);
			this.log('startClient -> Done');
			this.log('decryptSubscriptions');

			this.decryptSubscriptions();
			this.log('decryptSubscriptions -> Done');
		});
	}

	log(...msg) {
		console.log('E2E', ...msg);
	}

	error(...msg) {
		console.error('E2E', ...msg);
	}

	isEnabled() {
		return this.enabled.get();
	}

	setEnabled(enabled) {
		this.enabled.set(enabled);
	}

	isReady() {
		return this.isEnabled() && this._ready.get();
	}

	async startClient() {
		if (this.started) {
			return;
		}

		this.log('startClient -> STARTED');

		this.started = true;
		let public_key = Meteor._localStorage.getItem('public_key');
		let private_key = Meteor._localStorage.getItem('private_key');

		await this.loadKeysFromDB();

		if (!public_key && this.db_public_key) {
			public_key = this.db_public_key;
		}

		if (!private_key && this.db_private_key) {
			try {
				private_key = await this.decodePrivateKey(this.db_private_key);
			} catch (error) {
				this.started = false;
				failedToDecodeKey = true;
				this.openAlert({
					title: TAPi18n.__('Wasn\'t possible to decode your encryption key to be imported.'),
					html: '<div>Your encryption password seems wrong. Click here to try again.</div>',
					modifiers: ['large', 'danger'],
					closable: true,
					icon: 'key',
					action: () => {
						this.startClient();
						this.closeAlert();
					},
				});
				return;
			}
		}

		if (public_key && private_key) {
			await this.loadKeys({ public_key, private_key });
		} else {
			await this.createAndLoadKeys();
		}

		// TODO: Split in 2 methods to persist keys
		if (!this.db_public_key || !this.db_private_key) {
			await APIClient.v1.post('e2e.setUserPublicAndPrivateKeys', {
				public_key: Meteor._localStorage.getItem('public_key'),
				private_key: await this.encodePrivateKey(Meteor._localStorage.getItem('private_key'), this.createRandomPassword()),
			});
		}

		const randomPassword = Meteor._localStorage.getItem('e2e.randomPassword');
		if (randomPassword) {
			const passwordRevealText = TAPi18n.__('E2E_password_reveal_text', {
				postProcess: 'sprintf',
				sprintf: [randomPassword],
			});

			this.openAlert({
				title: TAPi18n.__('Save_Your_Encryption_Password'),
				html: TAPi18n.__('Click_here_to_view_and_copy_your_password'),
				modifiers: ['large'],
				closable: false,
				icon: 'key',
				action: () => {
					imperativeModal.open({ component: SaveE2EEPasswordModal,
						props: {
							passwordRevealText,
							onClose: imperativeModal.close,
							onCancel: () => {
								this.closeAlert();
								imperativeModal.close();
							},
							onConfirm: () => {
								Meteor._localStorage.removeItem('e2e.randomPassword');
								this.closeAlert();
								imperativeModal.close();
							},
						},
					});
				},
			});
		}
		this.emit('ready');
	}

	async stopClient() {
		this.log('-> Stop Client');
		this.closeAlert();

		Meteor._localStorage.removeItem('public_key');
		Meteor._localStorage.removeItem('private_key');
		this.untrackAll();
		this.privateKey = null;
		this.setEnabled(false);
		this._ready.set(false);
		this.started = false;
	}

	async changePassword(newPassword) {
		await APIClient.v1.post('e2e.setUserPublicAndPrivateKeys', {
			public_key: Meteor._localStorage.getItem('public_key'),
			private_key: await this.encodePrivateKey(Meteor._localStorage.getItem('private_key'), newPassword),
		});

		if (Meteor._localStorage.getItem('e2e.randomPassword')) {
			Meteor._localStorage.setItem('e2e.randomPassword', newPassword);
		}
	}

	async loadKeysFromDB() {
		try {
			const { public_key, private_key } = await APIClient.v1.get('e2e.fetchMyKeys');

			this.db_public_key = public_key;
			this.db_private_key = private_key;
		} catch (error) {
			return this.error('Error fetching RSA keys: ', error);
		}
	}

	async loadKeys({ public_key, private_key }) {
		Meteor._localStorage.setItem('public_key', public_key);

		try {
			this.privateKey = await importRSAKey(EJSON.parse(private_key), ['decrypt']);

			Meteor._localStorage.setItem('private_key', private_key);
		} catch (error) {
			return this.error('Error importing private key: ', error);
		}
	}

	async createAndLoadKeys() {
		// Could not obtain public-private keypair from server.
		let key;
		try {
			key = await generateRSAKey();
			this.privateKey = key.privateKey;
		} catch (error) {
			return this.error('Error generating key: ', error);
		}

		try {
			const publicKey = await exportJWKKey(key.publicKey);

			Meteor._localStorage.setItem('public_key', JSON.stringify(publicKey));
		} catch (error) {
			return this.error('Error exporting public key: ', error);
		}

		try {
			const privateKey = await exportJWKKey(key.privateKey);

			Meteor._localStorage.setItem('private_key', JSON.stringify(privateKey));
		} catch (error) {
			return this.error('Error exporting private key: ', error);
		}

		this.requestSubscriptionKeys();
	}

	async requestSubscriptionKeys() {
		await APIClient.v1.post('e2e.requestSubscriptionKeys');
	}

	createRandomPassword() {
		const randomPassword = `${ Random.id(3) }-${ Random.id(3) }-${ Random.id(3) }`.toLowerCase();
		Meteor._localStorage.setItem('e2e.randomPassword', randomPassword);
		return randomPassword;
	}

	async encodePrivateKey(private_key, password) {
		const masterKey = await this.getMasterKey(password);

		const vector = crypto.getRandomValues(new Uint8Array(16));
		try {
			const encodedPrivateKey = await encryptAES(vector, masterKey, toArrayBuffer(private_key));

			return EJSON.stringify(joinVectorAndEncryptedData(vector, encodedPrivateKey));
		} catch (error) {
			return this.error('Error encrypting encodedPrivateKey: ', error);
		}
	}

	async getMasterKey(password) {
		if (password == null) {
			alert('You should provide a password');
		}

		// First, create a PBKDF2 "key" containing the password
		let baseKey;
		try {
			baseKey = await importRawKey(toArrayBuffer(password));
		} catch (error) {
			return this.error('Error creating a key based on user password: ', error);
		}

		// Derive a key from the password
		try {
			return await deriveKey(toArrayBuffer(Meteor.userId()), baseKey);
		} catch (error) {
			return this.error('Error deriving baseKey: ', error);
		}
	}

	async requestPassword() {
		return new Promise((resolve) => {
			const showModal = () => {
				imperativeModal.open({
					component: EnterE2EEPasswordModal,
					props: {
						onClose: imperativeModal.close,
						onCancel: () => {
							failedToDecodeKey = false;
							this.closeAlert();
							imperativeModal.close();
						},
						onConfirm: (password) => {
							resolve(password);
							this.closeAlert();
							imperativeModal.close();
						},
					},
				});
			};

			const showAlert = () => {
				this.openAlert({
					title: TAPi18n.__('Enter_your_E2E_password'),
					html: TAPi18n.__('Click_here_to_enter_your_encryption_password'),
					modifiers: ['large'],
					closable: false,
					icon: 'key',
					action() {
						showModal();
					},
				});
			};

			if (failedToDecodeKey) {
				showModal();
			} else {
				showAlert();
			}
		});
	}

	async decodePrivateKey(private_key) {
		const password = await this.requestPassword();

		const masterKey = await this.getMasterKey(password);

		const [vector, cipherText] = splitVectorAndEncryptedData(EJSON.parse(private_key));

		try {
			const privKey = await decryptAES(vector, masterKey, cipherText);
			return toString(privKey);
		} catch (error) {
			throw new Error('E2E -> Error decrypting private key');
		}
	}

	async decryptPendingMessages() {
		return Messages.find({ t: 'e2e', e2e: 'pending' }).forEach(async ({ _id, ...msg }) => {
			Messages.direct.update({ _id }, await this.decryptMessage(msg));
		});
	}

	async decryptSubscription(rid) {
		const roomClient = this.roomClients.track(rid);
		await roomClient.whenReady();
		this.log('decryptSubscription ->', rid);
		roomClient.decryptSubscription();
	}

	async decryptSubscriptions() {
		Subscriptions.find({
			encrypted: true,
		}).forEach((room) => this.decryptSubscription(room._id));
	}

	openAlert(config) {
		banners.open({ id: 'e2e', ...config });
	}

	closeAlert() {
		banners.closeById('e2e');
	}

	toggle(enabled) {
		if (enabled) {
			this.startClient();
			this.setEnabled(true);
			return;
		}

		this.setEnabled(false);
		this.closeAlert();
	}
}

export const e2e = new E2E();
