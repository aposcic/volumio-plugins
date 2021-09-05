'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const io = require('socket.io-client');
const PausableTimer = require('./pausableTimer');
const socket = io.connect('http://localhost:3000');
const lastfm = require("simple-lastfm");
const libQ = require('kew');

let supportedSongServices; // = ["mpd", "airplay", "volspotconnect", "volspotconnect2", "spop", "radio_paradise", "80s80s"];
let supportedStreamingServices; // = ["webradio"];

// Define the ControllerLastFM class
module.exports = ControllerLastFM;

// Plugin setup and init -----------------------------------------------------------------------------------------------

function ControllerLastFM(context) {
    const self = this;
    self.previousState = null;
    self.updatingNowPlaying = false;
    self.timeToPlay = 0;
    self.apiResponse = null;
    self.previousScrobble =
        {
            artist: '',
            title: '',
            scrobbleTime: 0
        };
    self.scrobbleData =
        {
            artist: '',
            title: '',
            album: ''
        };

    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;

    this.currentTimer = undefined;
    this.memoryTimer = undefined;
}

ControllerLastFM.prototype.resetState = function() {
    const self = this;
    self.previousState = null;
    self.updatingNowPlaying = false;
    self.timeToPlay = 0;
    self.apiResponse = null;
    self.previousScrobble =
        {
            artist: '',
            title: '',
            scrobbleTime: 0
        };
    self.scrobbleData =
        {
            artist: '',
            title: '',
            album: ''
        };
}

// noinspection JSUnusedGlobalSymbols
ControllerLastFM.prototype.onVolumioStart = function () {
    const self = this;
    this.configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    self.getConf(this.configFile);

    return libQ.resolve(undefined);
};

// noinspection JSUnusedGlobalSymbols
ControllerLastFM.prototype.onStart = function () {
    const self = this;
    self.logger.info("[Last.fm] performing onStart action");

    supportedSongServices = self.config.get('supportedSongServices').split(',');
    supportedStreamingServices = self.config.get('supportedStreamingServices').split(',');

    let initialize = false;

    if (self.config.get('enable_debug_logging')) {
        self.logger.info('[Last.fm] supported song services: ' + JSON.stringify(supportedSongServices));
        self.logger.info('[Last.fm] supported streaming services: ' + JSON.stringify(supportedStreamingServices));
    }

    self.logger.info('[Last.fm] scrobbler initiated!');
    self.logger.info('[Last.fm] extended logging: ' + self.config.get('enable_debug_logging'));
    self.logger.info('[Last.fm] scrobbling enabled: ' + self.config.get('scrobble'));
    self.logger.info('[Last.fm] clean titles: ' + self.config.get('cleanTitles'));
    self.logger.info('[Last.fm] try scrobble stream/radio plays: ' + self.config.get('scrobbleFromStream'));
    self.currentTimer = new PausableTimer(self.context, self.config.get('enable_debug_logging'));

    socket.on('pushState', function (state) {
        // Create the timer object
        if (!self.currentTimer) {
            self.currentTimer = new PausableTimer(self.context, self.config.get('enable_debug_logging'));
            if (self.config.get('enable_debug_logging'))
                self.logger.info('[Last.fm] created new timer object');
        } else {
            if (self.config.get('enable_debug_logging'))
                self.logger.info('[Last.fm] using existing timer');
        }

        let scrobbleThresholdInMilliseconds = 0;
        if (supportedSongServices.indexOf(state.service) !== -1)
            scrobbleThresholdInMilliseconds = state.duration * (self.config.get('scrobbleThreshold') / 100) * 1000;
        if (self.config.get('scrobbleFromStream') && supportedStreamingServices.indexOf(state.service) !== -1)
            scrobbleThresholdInMilliseconds = self.config.get('streamScrobbleThreshold') * 1000;

        // Set initial previousState object
        let init = '';
        if (self.previousState == null) {
            self.previousState = state;
            initialize = true;
            init = ' | Initializing: true';
        }

        if (self.config.get('enable_debug_logging')) {
            self.logger.info(
                '--------------------------------------------------------------------// [Last.fm] new state has been pushed; status: ' + state.status +
                ' | service: ' + state.service + ' | duration: ' + state.duration +
                ' | title: ' + state.title + ' | previous title: ' + self.previousState.title + init);
            if (self.currentTimer)
                self.logger.info('=================> [timer] is active: ' + self.currentTimer.isActive +
                    ' | can continue: ' + self.currentTimer.canContinue + ' | timer started at: ' + self.currentTimer.timerStarted);
        }

        self.formatScrobbleData(state);

        // Scrobble from all services, or at least try to -> improves forward compatibility (but only if scrobbling is enabled)
        if (state.status === 'play' && self.config.get('scrobble')) {
            if (self.config.get('enable_debug_logging'))
                self.logger.info('Playback detected, evaluating parameters for scrobbling...');

            // Try to update 'now playing' only if service is enabled
            if (supportedSongServices.indexOf(state.service) !== -1 || supportedStreamingServices.indexOf(state.service) !== -1)
                self.updateNowPlaying(state);

            /*
                Either same song and previously stopped/paused
                Or different song (artist or title differs)
            */
            if
            (
                (
                    self.previousState.artist === state.artist && self.previousState.title === state.title
                    &&
                    (
                        (self.previousState.status === 'pause' || self.previousState.status === 'stop') ||
                        initialize ||
                        (self.previousState.duration !== state.duration)
                    )
                )
                ||
                (
                    self.currentTimer && !self.currentTimer.isActive &&
                    (self.previousScrobble.artist !== state.artist || self.previousScrobble.title !== state.title)
                )
            ) {
                if (self.config.get('enable_debug_logging'))
                    self.logger.info('[Last.fm] Continuing playback or different song.');

                // Song service, since duration is > 0
                if (state.duration > 0) {
                    if (self.config.get('enable_debug_logging'))
                        self.logger.info('[Last.fm] timeToPlay for current track: ' + self.timeToPlay);

                    // Continuing playback, timeToPlay was populated
                    if (self.timeToPlay > 0) {
                        if (self.config.get('enable_debug_logging'))
                            self.logger.info('[Last.fm] Continuing scrobble, starting new timer for the remainder of ' +
                                self.timeToPlay + ' milliseconds [' + state.artist + ' - ' + state.title + '].');

                        self.stopAndStartTimer(self.timeToPlay, state, scrobbleThresholdInMilliseconds);
                    } else {
                        // Create a new timer
                        if (scrobbleThresholdInMilliseconds > 0) {
                            if (self.config.get('enable_debug_logging'))
                                self.logger.info('[Last.fm] starting new timer for ' +
                                    scrobbleThresholdInMilliseconds + ' milliseconds [' + state.artist + ' - ' + state.title + '].');

                            self.stopAndStartTimer(scrobbleThresholdInMilliseconds, state, scrobbleThresholdInMilliseconds);
                        } else {
                            if (self.config.get('enable_debug_logging'))
                                self.logger.info('[Last.fm] can not scrobble; state object: ' + JSON.stringify(state));
                        }
                    }
                } else if (state.duration === 0 && state.service === 'webradio') {
                    if (self.config.get('enable_debug_logging'))
                        self.logger.info('[Last.fm] starting new timer for ' +
                            scrobbleThresholdInMilliseconds + ' milliseconds [webradio: ' + state.title + '].');

                    self.stopAndStartTimer(scrobbleThresholdInMilliseconds, state, scrobbleThresholdInMilliseconds);
                }

                if (initialize)
                    initialize = false;
            } else if (
                self.previousState.artist === state.artist && self.previousState.title === state.title &&
                self.previousState.duration !== state.duration && !self.currentTimer.isActive
            ) {
                // Airplay fix, the duration is propagated at a later point in time
                const addition = (state.duration - self.previousState.duration) * (self.config.get('scrobbleThreshold') / 100) * 1000;
                self.logger.info('[Last.fm] updating timer, previous duration is obsolete; adding ' + addition + ' milliseconds.');
                self.currentTimer.addMilliseconds(addition, function () {
                    self.scrobble(state, self.config.get('scrobbleThreshold'), scrobbleThresholdInMilliseconds);
                    self.currentTimer.stop();
                    self.timeToPlay = 0;
                });
            } else if (
                self.previousState.artist === state.artist && self.previousState.title === state.title &&
                self.previousState.duration === state.duration
            ) {
                // Just a state update, no action necessary
                if (self.config.get('enable_debug_logging'))
                    self.logger.info('[Last.fm] same state, different update... no action required.');
            } else {
                if (self.config.get('enable_debug_logging'))
                    self.logger.info('[Last.fm] could not process current state: ' + JSON.stringify(state));
            }
            // else = multiple pushStates without change, ignoring them
        } else if (state.status === 'pause') {
            if (self.currentTimer.isActive) {
                self.timeToPlay = self.currentTimer.pause();
                self.previousState = state;
            }
        } else if (state.status === 'stop') {
            if (self.config.get('enable_debug_logging'))
                self.logger.info('[Last.fm] stopping timer, song has ended.');

            if (self.currentTimer.isActive) {
                self.currentTimer.stop();
                self.previousState = state;
            }
            self.timeToPlay = 0;
        }

        self.previousState = state;
    });

    return libQ.resolve(undefined);
};

// noinspection JSUnusedGlobalSymbols
ControllerLastFM.prototype.onStop = function () {
    const self = this;
    self.logger.info("[Last.fm] performing onStop action");

    if (self.currentTimer && self.currentTimer.isActive) {
        self.currentTimer.stop();
    }

    if (self.memoryTimer && self.memoryTimer.isActive) {
        self.memoryTimer.stop();
    }

    if (self.config.get('enable_debug_logging'))
        self.logger.info("[Last.fm] removing listeners: " + socket.listeners('pushState').length)
    socket.off('pushState')

    this.resetState()

    return libQ.resolve(undefined);
};

// Plugin configuration ------------------------------------------------------------------------------------------------

ControllerLastFM.prototype.getConf = function (configFile) {
    this.config = new (require('v-conf'))()
    this.config.loadFile(configFile)

    return libQ.resolve(undefined);
};

// noinspection JSUnusedGlobalSymbols
ControllerLastFM.prototype.getUIConfig = function () {
    const self = this;
    const defer = libQ.defer();

    const lang_code = this.commandRouter.sharedVars.get('language_code');
    self.getConf(this.configFile);

    self.logger.info("[Last.fm] loaded the previous config.");

    const thresholds = fs.readJsonSync((__dirname + '/options/thresholds.json'), 'utf8', {throws: false});

    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function (uiconf) {
            self.logger.info("[Last.fm] populating UI...");

            // Credentials settings
            uiconf.sections[0].content[0].value = self.config.get('API_KEY');
            uiconf.sections[0].content[1].value = self.config.get('API_SECRET');
            uiconf.sections[0].content[2].value = self.config.get('username');
            if (self.config.get('password') !== undefined && self.config.get('password') !== '')
                uiconf.sections[0].content[3].value = self.config.get('password');
            else
                uiconf.sections[0].content[3].value = '******';
            self.logger.info("[Last.fm] 1/3 settings loaded");

            // Scrobble settings
            uiconf.sections[1].content[0].value = self.config.get('scrobble');
            uiconf.sections[1].content[1].value = self.config.get('supportedSongServices');
            for (let n = 0; n < thresholds.percentages.length; n++) {
                self.configManager.pushUIConfigParam(uiconf, 'sections[1].content[1].options', {
                    value: thresholds.percentages[n].perc,
                    label: thresholds.percentages[n].desc
                });

                if (thresholds.percentages[n].perc === parseInt(self.config.get('scrobbleThreshold'))) {
                    uiconf.sections[1].content[2].value.value = thresholds.percentages[n].perc;
                    uiconf.sections[1].content[2].value.label = thresholds.percentages[n].desc;
                }
            }
            uiconf.sections[1].content[3].value = self.config.get('cleanTitles');
            uiconf.sections[1].content[4].value = self.config.get('pushToastOnScrobble');
            uiconf.sections[1].content[5].value = self.config.get('scrobbleFromStream');
            uiconf.sections[1].content[6].value = self.config.get('supportedStreamingServices');
            uiconf.sections[1].content[7].value = self.config.get('streamScrobbleThreshold');
            self.logger.info("[Last.fm] 2/3 settings loaded");

            uiconf.sections[2].content[0].value = self.config.get('enable_debug_logging');
            self.logger.info("[Last.fm] 3/3 settings loaded");

            self.logger.info("[Last.fm] populated config screen.");

            defer.resolve(uiconf);
        })
        .fail(function () {
            defer.reject(new Error());
        });

    return defer.promise;
};

// noinspection JSUnusedGlobalSymbols
ControllerLastFM.prototype.updateCredentials = function (data) {
    const self = this;
    const defer = libQ.defer();

    self.config.set('API_KEY', data['API_KEY']);
    self.config.set('API_SECRET', data['API_SECRET']);
    self.config.set('username', data['username']);
    if (data['storePassword'] && data['password'] !== undefined && data['password'] !== '' && data['password'] !== '******')
        self.config.set('password', data['password']);
    self.config.set('authToken', md5(data['username'] + md5(data['password'])));
    defer.resolve();

    self.commandRouter.pushToastMessage('success', "Saved settings", "Successfully saved authentication settings.");

    return defer.promise;
};

// noinspection JSUnusedGlobalSymbols
ControllerLastFM.prototype.updateScrobbleSettings = function (data) {
    const self = this;
    const defer = libQ.defer();

    self.config.set('scrobble', data['scrobble']);
    self.config.set('supportedSongServices', data['supportedSongServices']);
    self.config.set('scrobbleThreshold', data['scrobbleThreshold'].value);
    self.config.set('cleanTitles', data['cleanTitles']);
    self.config.set('pushToastOnScrobble', data['pushToastOnScrobble']);
    self.config.set('scrobbleFromStream', data['scrobbleFromStream']);
    self.config.set('supportedStreamingServices', data['supportedStreamingServices']);
    self.config.set('streamScrobbleThreshold', data['streamScrobbleThreshold']);
    defer.resolve();

    self.commandRouter.pushToastMessage('success', "Saved settings", "Successfully saved scrobble settings.");

    return defer.promise;
};

// noinspection JSUnusedGlobalSymbols
ControllerLastFM.prototype.updateDebugSettings = function (data) {
    const self = this;
    const defer = libQ.defer();

    self.config.set('enable_debug_logging', data['enable_debug_logging']);
    defer.resolve();

    self.commandRouter.pushToastMessage('success', "Saved settings", "Successfully saved debug settings.");

    return defer.promise;
};

// Plugin utils ------------------------------------------------------------------------------------------------

ControllerLastFM.prototype.stopAndStartTimer = function (timerLength, state, scrobbleThresholdInMilliseconds) {
    const self = this;
    const defer = libQ.defer();

    try {
        self.currentTimer.stop();
        self.currentTimer.start(timerLength, function () {
            if (self.config.get('enable_debug_logging'))
                self.logger.info('[Last.fm] scrobbling from restarted timer.');
            self.scrobble(state, self.config.get('scrobbleThreshold'), scrobbleThresholdInMilliseconds);
            self.currentTimer.stop();
            self.timeToPlay = 0;
        });
        defer.resolve();
    } catch (ex) {
        self.logger.error('[Last.fm] An error occurred during timer reset; ' + ex);
        self.logger.info('[Last.fm] STATE; ' + JSON.stringify(state));
        defer.reject(undefined);
    }

    return defer.promise;
};

ControllerLastFM.prototype.clearScrobbleMemory = function (remainingTimeToPlay) {
    const self = this;
    self.memoryTimer = setInterval(function () {
            self.previousScrobble.artist = '';
            self.previousScrobble.title = '';
        }
        , remainingTimeToPlay);
}

function md5(string) {
    return crypto.createHash('md5').update(string, 'utf8').digest("hex");
}

function cleanTitle(title) {
    return title
        .replace(/([\/-] )?([(\[]?\d+[)\]]?)? ?remastere?d? ?(version)?([(\[]?\d+[)\]]?)?| [(\[].*remastere?d?.*[)\]]/i, '')
        .replace(/ ([\/-] .*)? ?album version.*| [(\[].*?album version.*?[)\]]/i, '')
        .replace(/ [(\[](\d+|bonus track) edition[)\]]/i, '')
        .replace(/ ([\/-] )? ?explicit ?(.*?version)?| [(\[].*?explicit.*?[)\]]/i, '');
}

// Plugin scrobble methods ---------------------------------------------------------------------------------------------

ControllerLastFM.prototype.formatScrobbleData = function (state) {
    const self = this;
    const defer = libQ.defer();
    const cleanTitles = self.config.get('cleanTitles')

    self.scrobbleData.artist = state.artist;
    self.scrobbleData.title = cleanTitles ? cleanTitle(state.title) : state.title;
    self.scrobbleData.album = state.album == null ? '' : cleanTitles ? cleanTitle(state.album) : state.album;

    if (
        ((self.scrobbleData.title !== undefined && !self.scrobbleData.artist) ||
            supportedStreamingServices.indexOf(state.service) !== -1) && self.scrobbleData.title.indexOf('-') > -1
    ) {
        try {
            const info = state.title.split('-');
            self.scrobbleData.artist = info[0].trim();
            self.scrobbleData.title = info[1].trim();
            self.scrobbleData.album = '';
        } catch (ex) {
            self.logger.error('[Last.fm] an error occurred during parse; ' + ex);
            self.logger.info('[Last.fm] STATE; ' + JSON.stringify(state));
        }
    }
    defer.resolve();

    return defer.promise;
};

ControllerLastFM.prototype.updateNowPlaying = function (state) {
    const self = this;
    const defer = libQ.defer();
    self.updatingNowPlaying = true;

    if (self.config.get('enable_debug_logging'))
        self.logger.info('[Last.fm] updating now playing');

    self.formatScrobbleData(state);

    if (
        (self.config.get('API_KEY') !== '') &&
        (self.config.get('API_SECRET') !== '') &&
        (self.config.get('username') !== '') &&
        (self.config.get('authToken') !== '') &&
        self.scrobbleData.artist !== undefined &&
        self.scrobbleData.title !== undefined &&
        self.scrobbleData.album !== undefined
    ) {
        if (self.config.get('enable_debug_logging'))
            self.logger.info('[Last.fm] trying to authenticate...');

        const lfm = new lastfm({
            api_key: self.config.get('API_KEY'),
            api_secret: self.config.get('API_SECRET'),
            username: self.config.get('username'),
            authToken: self.config.get('authToken')
        });

        lfm.getSessionKey(function (result) {
            if (result.success) {
                if (self.config.get('enable_debug_logging'))
                    self.logger.info('[Last.fm] authenticated successfully!');
                // Use the last.fm corrections data to check whether the supplied track has a correction to a canonical track
                lfm.getCorrection({
                    artist: self.scrobbleData.artist,
                    track: self.scrobbleData.title,
                    callback: function (result) {
                        if (result.success) {
                            // Try to correct the artist
                            if (
                                result.correction.artist.name !== undefined && result.correction.artist.name !== '' &&
                                self.scrobbleData.artist !== result.correction.artist.name
                            ) {
                                self.logger.info('[Last.fm] corrected artist from: ' +
                                    self.scrobbleData.artist + ' to: ' + result.correction.artist.name);
                                self.scrobbleData.artist = result.correction.artist.name;
                            }

                            // Try to correct the track title
                            if (
                                result.correction.name !== undefined && result.correction.name !== '' &&
                                self.scrobbleData.title !== result.correction.name
                            ) {
                                self.logger.info('[Last.fm] corrected track title from: ' +
                                    self.scrobbleData.title + ' to: ' + result.correction.name);
                                self.scrobbleData.title = result.correction.name;
                            }
                        } else
                            self.logger.info('[Last.fm] request failed with error: ' + result.error);
                    }
                })

                // Used to notify Last.fm that a user has started listening to a track. Parameter names are case sensitive.
                lfm.scrobbleNowPlayingTrack({
                    artist: self.scrobbleData.artist,
                    track: self.scrobbleData.title,
                    album: self.scrobbleData.album,
                    duration: state.duration,
                    callback: function (result) {
                        if (!result.success)
                            console.log("in callback, finished: ", result);
                        else {
                            if (self.config.get('enable_debug_logging'))
                                self.logger.info('[Last.fm] updated "now playing" | artist: ' +
                                    self.scrobbleData.artist + ' | title: ' + self.scrobbleData.title);
                        }
                    }
                });
            } else {
                self.logger.info("[Last.fm] error: " + result.error);
            }
        });
    } else {
        // Configuration errors
        if (self.config.get('API_KEY') === '')
            self.logger.info('[Last.fm] configuration error; "API_KEY" is not set.');
        if (self.config.get('API_SECRET') === '')
            self.logger.info('[Last.fm] configuration error; "API_SECRET" is not set.');
        if (self.config.get('username') === '')
            self.logger.info('[Last.fm] configuration error; "username" is not set.');
        if (self.config.get('authToken') === '')
            self.logger.info('[Last.fm] configuration error; "authToken" is not set.');
    }

    //self.currentTimer = null;
    self.updatingNowPlaying = false;
    return defer.promise;
};

ControllerLastFM.prototype.scrobble = function (state, scrobbleThreshold, scrobbleThresholdInMilliseconds) {
    const self = this;
    const defer = libQ.defer();

    self.formatScrobbleData(state);

    if (self.config.get('enable_debug_logging')) {
        self.logger.info('[Last.fm] checking previously scrobbled song...');
        self.logger.info('[Last.fm] previous scrobble: ' + JSON.stringify(self.previousScrobble));
    }

    if (
        (self.config.get('API_KEY') !== '') &&
        (self.config.get('API_SECRET') !== '') &&
        (self.config.get('username') !== '') &&
        (self.config.get('authToken') !== '') &&
        self.scrobbleData.artist !== undefined &&
        self.scrobbleData.title !== undefined &&
        self.scrobbleData.album !== undefined
    ) {
        if (self.config.get('enable_debug_logging'))
            self.logger.info('[Last.fm] trying to authenticate for scrobbling...');

        const lfm = new lastfm({
            api_key: self.config.get('API_KEY'),
            api_secret: self.config.get('API_SECRET'),
            username: self.config.get('username'),
            authToken: self.config.get('authToken')
        });

        lfm.getSessionKey(function (result) {
            if (result.success) {
                if (self.config.get('enable_debug_logging'))
                    self.logger.info('[Last.fm] authenticated successfully for scrobbling!');

                // Use the last.fm corrections data to check whether the supplied track has a correction to a canonical track
                lfm.getCorrection({
                    artist: self.scrobbleData.artist,
                    track: self.scrobbleData.title,
                    callback: function (result) {
                        if (result.success) {
                            // Try to correct the artist
                            if (
                                result.correction.artist.name !== undefined && result.correction.artist.name !== '' &&
                                self.scrobbleData.artist !== result.correction.artist.name
                            ) {
                                self.logger.info('[Last.fm] corrected artist from: ' +
                                    self.scrobbleData.artist + ' to: ' + result.correction.artist.name);
                                self.scrobbleData.artist = result.correction.artist.name;
                            }

                            // Try to correct the track title
                            if (
                                result.correction.name !== undefined && result.correction.name !== '' &&
                                self.scrobbleData.title !== result.correction.name
                            ) {
                                self.logger.info('[Last.fm] corrected track title from: ' +
                                    self.scrobbleData.title + ' to: ' + result.correction.name);
                                self.scrobbleData.title = result.correction.name;
                            }
                        } else
                            self.logger.info('[Last.fm] request failed with error: ' + result.error);
                    }
                });

                if (self.config.get('enable_debug_logging'))
                    self.logger.info('[Last.fm] preparing to scrobble...');

                lfm.scrobbleTrack({
                    artist: self.scrobbleData.artist,
                    track: self.scrobbleData.title,
                    album: self.scrobbleData.album,
                    callback: function (result) {
                        if (!result.success)
                            console.log("in callback, finished: ", result);

                        if (self.scrobbleData.album === undefined || self.scrobbleData.album === '')
                            self.scrobbleData.album = '[unknown album]';

                        if (self.config.get('pushToastOnScrobble'))
                            self.commandRouter.pushToastMessage('success', 'Scrobble successful', 'Scrobbled: ' +
                                self.scrobbleData.artist + ' - ' + self.scrobbleData.title + ' (' + self.scrobbleData.album + ').');
                        if (self.config.get('enable_debug_logging'))
                            self.logger.info('[Last.fm] scrobble successful for: ' +
                                self.scrobbleData.artist + ' - ' + self.scrobbleData.title + ' (' + self.scrobbleData.album + ').');
                    }
                });
            } else {
                self.logger.info("[Last.fm] error: " + result.error);
            }
        });

        self.previousScrobble.artist = self.scrobbleData.artist;
        self.previousScrobble.title = self.scrobbleData.title;
        self.clearScrobbleMemory((state.duration * 1000) - scrobbleThresholdInMilliseconds);
    } else {
        // Configuration errors
        if (self.config.get('API_KEY') === '')
            self.logger.info('[Last.fm] configuration error; "API_KEY" is not set.');
        if (self.config.get('API_SECRET') === '')
            self.logger.info('[Last.fm] configuration error; "API_SECRET" is not set.');
        if (self.config.get('username') === '')
            self.logger.info('[Last.fm] configuration error; "username" is not set.');
        if (self.config.get('authToken') === '')
            self.logger.info('[Last.fm] configuration error; "authToken" is not set.');
    }

    //self.currentTimer = null;
    return defer.promise;
};

