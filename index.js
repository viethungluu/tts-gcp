// Node libraries
const fs = require('fs');
const os = require('os');
const path = require('path');

// Google APIs
const TextToSpeech = require('@google-cloud/text-to-speech');
const {Storage} = require('@google-cloud/storage');

// Other packages
const chunkText = require('chunk-text');
const async = require('async');

const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path
const ffmpeg = require('fluent-ffmpeg');

const { v4: uuidv4 } = require('uuid');
const uuidToHex = require('uuid-to-hex');

const rmrf = require('rimraf');

// Global constants [FILL ME IT!]
const workingDir = path.join(os.tmpdir(), 'mp3'); // Change this if running locally
const gcpProjectId = "voiceovertom";
const gcpBucketName = "voiceovertom";

exports.articleToAudio = (req, res) => {
    if (req.body.content === undefined) {
        res.status(400).send('No text provided!');
    } else {
        rmrf(workingDir, (err) => {
            fs.mkdirSync(workingDir);
            
            content = chunkText(req.body.content, 5000);
            const ttsParams = {
                pitch: req.body.pitch,
                speakingRate: req.body.speakingRate,
                volumeGainDb: req.body.volumeGainDb,
                name: req.body.voiceCode,
                languageCode: req.body.langCode,
                inputType: req.body.inputType,
                ssmlGender: req.body.gender,
                effectsProfileId: req.body.effectsProfileId
            }
            
            async.map(content, async.apply(getTtsAudio, ttsParams), (err, audio) => {
                if (err) { res.status(500).send('TTS conversion failed.\n' + err); }
                else{
                    async.eachOf(audio, writeAudioFiles, (err) => {
                        if (err) { res.status(500).send('Failed to write audio segment(s) to disk.\n' + err); }
                        else {
                            fs.readdir(workingDir, (err, fileNames) => {
                                fileNames.sort();
                                let filePaths = fileNames.map((x) => { return path.join(workingDir, x); });
                                concatAudioFiles(filePaths, (err, singleFilePath) => {
                                    if (err) { res.status(500).send('Failed to concatinate audio files.\n' + err); }
                                    else{
                                        createGcsObject(singleFilePath, (err, voice_url) => {
                                            if (err) { res.status(500).send('Could not send audio to GCS.\n' + err); }
                                            else {
                                                res.status(200).json({voiceUrl: voice_url});
                                            }
                                        });
                                    }
                                });
                            });
                        }
                    });
                }
            });
        });
    }
};

// Uses Googles Text-To-Speech API to generate audio from text
function getTtsAudio(ttsParams, str, cb) {
    const ttsClient = new TextToSpeech.TextToSpeechClient();
    const ttsRequest = {
        input: { text: str },
        voice: { 
            languageCode: ttsParams.languageCode, 
            name: ttsParams.name, 
            ssmlGender: ttsParams.ssmlGender 
        },
        audioConfig: { 
            audioEncoding: 'MP3',
            speakingRate: ttsParams.speakingRate,
            pitch: ttsParams.pitch,
            volumeGainDb: ttsParams.volumeGainDb,
            effectsProfileId: ttsParams.effectsProfileId
        },
    };
    
    ttsClient.synthesizeSpeech(ttsRequest, (err, res) => {
        if (err) { cb(err, null); }
        else { cb(null, res.audioContent); }
    });
}

// Used to write audioData to disk before concatinating with ffmpeg
function writeAudioFiles(audioData, key, cb) {
    key = key + 1000; // To make sorting of files easier later
    filePath = path.join(workingDir, key + '.mp3');
    fs.writeFile(filePath, audioData, 'binary', (err) => {
        if (err) { cb(err); }
        else { cb(null); }
    });
}

// Used to concatinate audio files with ffmpeg and retunrs the path to the concatinated file
function concatAudioFiles(filePaths, cb) {
    if (filePaths.length == 1) { cb(null, filePaths[0]); }
    else {
        const singleFilePath = path.join(workingDir, 'article.wav');

        // set ffmpeg package path
        ffmpeg.setFfmpegPath(ffmpegPath);

        var ffmpegCmd = ffmpeg();
        filePaths.forEach((x) => { ffmpegCmd.input(x); });
        ffmpegCmd.on('error', (err) => { cb(err, null); })
                 .on('end', () => { cb(null, singleFilePath); })
                 .mergeToFile(singleFilePath, workingDir);
    }
}

// Used to send concatinated audio file to Google Cloud Storage
function createGcsObject(audioPath, cb) {
    // const storage = new Storage({ projectId: gcpProjectId });
    const storage = new Storage(gcpProjectId);
    
    // Get random object name
    var blob_name = uuidToHex(uuidv4()) + '.wav';
    const objectOptions = {
        destination: blob_name,
        public: true,
        metadata: {
            contentType: 'file/basic'
        }
    };
    
    storage
        .bucket(gcpBucketName)
        .upload(audioPath, objectOptions, (err, metadata, apiResponse) => {
            if (err) { cb(err, null); }
            else { cb(null, `https://storage.googleapis.com/${gcpBucketName}/${blob_name}`); }
        });
}