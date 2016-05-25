'use strict'

const fs = require('fs');
const path = require('path');
const exec = require('child_process').exec;
const mkdirp = require('mkdirp');

const GHOSTSCRIPT_ARGUMENTS         = process.env.ASTFAX_GS_ARGS || '-q -dNOPAUSE -dBATCH -sDEVICE=tiffg4 -sPAPERSIZE=letter';
const TIFF2PDF_ARGUMENTS            = process.env.ASTFAX_T2P_ARGS || '-p letter -f -d';

const ASTERISK_SPOOL_OUTGOING_DIR   = process.env.ASTFAX_SPOOL_OUT_DIR || '/var/spool/asterisk/outgoing/';
const ASTERISK_SPOOL_FAX_IN_DIR     = process.env.ASTFAX_FAX_IN_DIR || '/var/spool/asterisk/fax/incoming/';
const ASTERISK_SPOOL_FAX_OUT_DIR    = process.env.ASTFAX_FAX_OUT_DIR || '/var/spool/asterisk/fax/outgoing/';

const ASTERISK_USER_ID              = parseInt(process.env.ASTFAX_AST_UID) || 0;
const ASTERISK_GROUP_ID             = parseInt(process.env.ASTFAX_AST_GID) || 0;

const DEBUG                         = true;

class IncomingFaxProcessor {
    constructor(serverName, knex) {
        this.serverName = serverName;
        this.knex = knex;
    }
    
    processAndReceivePendingFaxes() {
        return new Promise((resolve, reject) => {
            mkdirp(ASTERISK_SPOOL_FAX_IN_DIR, (err) => {
                if (err) return reject({ msg: 'Could not create incoming fax directory', error: err });
                
                this.checkIncomingFaxes()
                    .then((pendingFaxesMetaFiles) => {
                        return Promise.all(pendingFaxesMetaFiles.map((pendingFaxMetaFile) => {
                            return this.processIncomingFax(path.join(ASTERISK_SPOOL_FAX_IN_DIR, pendingFaxMetaFile));
                        }));
                    })
                    .then((receivedFaxObjects) => {
                        return Promise.all(receivedFaxObjects.map((receivedFaxObject) => {
                            return this.receiveFax(receivedFaxObject);
                        }));
                    })
                    .then(resolve)
                    .catch(reject);
            });
        });
    }
    
    processIncomingFax(incomingFaxMetaFile) {
        return new Promise((resolve, reject) => {
            this.log(' Processing fax', incomingFaxMetaFile);

            let metadataObject = null;
            let serverId = null;
            let faxNumberId = null;
            let pdfFile = null;

            this.getIncomingFaxDataFromFile(incomingFaxMetaFile)
                .then((_metadataObject) => {
                    metadataObject = _metadataObject;

                    return this.getIAXFriendsIdFromServerName(this.serverName);
                })
                .then((_serverId) => {
                    serverId = _serverId;

                    return this.getFaxNumberIdFromNumber(metadataObject.to);
                })
                .then((_faxNumberId) => {
                    faxNumberId = _faxNumberId;
                    
                    return this.convertTiffToPDF(metadataObject.file);
                })
                .then((_pdfFile) => {
                    pdfFile = _pdfFile;
                    
                    return this.getPDFFileBuffer(pdfFile);
                })
                .then((pdfData) => {
                    resolve({
                        tenants_id: metadataObject.tenant_id,
                        iaxfriends_id: serverId,
                        filename: path.basename(pdfFile),
                        state: 'unread',
                        receive_time: new Date(parseInt(metadataObject.receive_time) * 1000),
                        from: metadataObject.from,
                        incoming_number_id: faxNumberId,
                        fax_data: pdfData
                    });
                })
                .catch(reject);
        });
    }
    
    getPDFFileBuffer(pdfFile) {
        return new Promise((resolve, reject) => {
            fs.readFile(pdfFile, (err, buf) => {
                if (err) return reject({msg: 'Could not read PDF file', error: err});
                
                resolve(buf);
            });
        });
    }
    
    getFaxNumberIdFromNumber(number) {
        return new Promise((resolve, reject) => {
            this.knex
                .select('id')
                .from('trunk_numbers')
                .where('full_number', number.replace('+', '00'))
                .orWhere('full_number', number.replace('00', '+'))
                .then((rows) => {
                    if (rows.length != 1)
                        return reject({ msg: 'Not one fax number with number ' + number, error: null });

                    resolve(parseInt(rows[0].id));
                })
                .catch(reject);
        });
    }
    
    getIAXFriendsIdFromServerName(serverName) {
        return new Promise((resolve, reject) => {
            this.knex
                .select('id')
                .from('iaxfriends')
                .where('name', serverName)
                .then((rows) => {
                    if (rows.length != 1)
                        return reject({ msg: 'Not one server with same name', error: null });

                    resolve(parseInt(rows[0].id));
                })
                .catch(reject);
        });
    }
    
    removeIncomingFaxFromServer(metaDataFile, tiffFile, pdfFile) {
        return new Promise((resolve, reject) => {
            fs.unlink(metaDataFile, (err) => {
                if (err) return reject({ msg: 'Could not delete incoming fax metadata file', error: err });

                fs.unlink(tiffFile, (err) => {
                    if (err) return reject({ msg: 'Could not delete incoming fax file', error: err });
                    
                    fs.unlink(pdfFile, (err) => {
                        if (err) return reject({ msg: 'Could not delete incoming fax pdf file', error: err });
                        
                        resolve();
                    });
                });
            });
        });
    }
    
    getIncomingFaxDataFromFile(file) {
        return new Promise((resolve, reject) => {
            fs.readFile(file, { encoding: 'utf8' }, (err, metaData) => {
                if (err) return reject({ msg: 'Could not read metadata file for incoming fax', error: err });

                let metaDataObject = null;

                try {
                    metaDataObject = JSON.parse(metaData);
                }
                catch (ex) {
                    return reject({ msg: 'Metadata file was not valid json', error: ex });
                }

                resolve(metaDataObject);
            });
        });
    }
    
    receiveFax(faxObject) {
        return new Promise((resolve, reject) => {
            let pdfFile = path.join(ASTERISK_SPOOL_FAX_IN_DIR, faxObject.filename);
            
            let faxMetadataFile = `${pdfFile.replace(/\.pdf/i, '.tiff')}.json`; 
            let faxFile = pdfFile.replace(/\.pdf/i, '.tiff');
            
            this.log('Deleting fax files', faxMetadataFile, faxFile);
            this.knex
                .insert(faxObject)
                .into('faxes_incoming')
                .then(() => {
                    return this.removeIncomingFaxFromServer(faxMetadataFile, faxFile, pdfFile);
                })
                .then(resolve)
                .catch(reject);
        });
    }
    
    checkIncomingFaxes() {
        return new Promise((resolve, reject) => {
            this.log('Checking pending faxes');

            fs.readdir(ASTERISK_SPOOL_FAX_IN_DIR, (err, files) => {
                if (err) return reject({ msg: 'Could not read incoming faxes directory', error: err });

                let metaFiles = files.filter((file) => { return file.indexOf('.json') > -1; });

                resolve(metaFiles);
            });
        });
    }
    
    convertTiffToPDF(tiffFile) {
        return new Promise((resolve, reject) => {
            let destinationPDFFile = tiffFile.replace(/\.tiff/i, '.pdf').replace(/\s/g, '_');
            
            this.log('Converting PDF file to TIFF', destinationPDFFile);
            
            let command = `tiff2pdf ${TIFF2PDF_ARGUMENTS} -o ${destinationPDFFile} ${tiffFile}`;
            
            exec(command, (err) => {
                if (err) return reject({ msg: 'Could not convert TIFF to PDF', error: err});
                
                resolve(destinationPDFFile); 
            });
        });
    }
    
    log(...logItems) {
        if (DEBUG) {
            console.log('Incoming ->', ...logItems);
        }
    }
}

class OutgoingFaxProcessor {
    constructor(serverName, knex) {
        this.serverName = serverName;
        this.knex = knex;
    }
    
    processAndSendPendingFaxes() {
        return new Promise((resolve, reject) => {
            // make sure required folders exists
            mkdirp(ASTERISK_SPOOL_FAX_OUT_DIR, (err) => {
                if (err) return reject({ msg: 'Could not create outgoing fax directory', error: err });

                this.checkOutgoingFaxes()
                    .then((pendingFaxes) => {
                        return Promise.all(pendingFaxes.map((pendingFax) => {
                            return this.processOutgoingFax(pendingFax);
                        }));
                    })
                    .then((callfiles) => {
                        return Promise.all(callfiles.map((callfile) => {
                            return this.sendFax(callfile);
                        }));
                    })
                    .then(resolve)
                    .catch(reject);
            });
        });
    }
    
    processOutgoingFax(outgoingFax) {
        return new Promise((resolve, reject) => {

            let id = outgoingFax.id;
            let fax_data = outgoingFax.fax_data;
            let filename = outgoingFax.filename;
            let outgoing_number_id = outgoingFax.outgoing_number_id;
            let to = outgoingFax.to;

            this.log('Processing fax', id);

            let pdfFile = null;
            let tiffFile = null;
            let callFile = null;

            this.updateFaxState(id, 'processing')
                .then(() => {
                    return this.writeFaxPDF(fax_data, filename);
                })
                .then((_pdfFile) => {
                    pdfFile = _pdfFile;

                    return this.convertPDFToTiff(pdfFile);
                })
                .then((_tiffFile) => {
                    tiffFile = _tiffFile;

                    return this.generateCallFile(outgoing_number_id, id, tiffFile, to);
                })
                .then((_callFile) => {
                    callFile = _callFile;

                    return this.updateFaxState(id, 'processed');
                })
                .then(() => {
                    return this.removeFaxPDF(pdfFile);
                })
                .then(() => {
                    resolve(callFile);
                })
                .catch(reject);
        });
    }
    
    sendFax(callfile) {
        return new Promise((resolve, reject) => {
            let filename = path.basename(callfile);

            this.setAsteriskPermissions(callfile).then(() => {
                let destination = path.join(ASTERISK_SPOOL_OUTGOING_DIR, filename);

                this.log('Moving callfile to', destination);

                fs.rename(callfile, path.join(ASTERISK_SPOOL_OUTGOING_DIR, filename), (err) => {
                    if (err) return reject({ msg: 'Could not move callfile to', ASTERISK_SPOOL_OUTGOING_DIR, error: err });

                    resolve();
                });
            });
        });
    }
    
    setAsteriskPermissions(file) {
        return new Promise((resolve, reject) => {
            this.log(`--> Setting permissions for ${file} to uid (${ASTERISK_USER_ID}) gid (${ASTERISK_GROUP_ID})`);

            fs.chown(file, ASTERISK_USER_ID, ASTERISK_GROUP_ID, (err) => {
                if (err) return reject({ msg: 'Could not change permissions for ' + file, error: err });

                resolve();
            });
        });
    }
    
    checkOutgoingFaxes() {
        return new Promise((resolve, reject) => {
            this.log('Checking pending faxes');
            this.knex
                .select('faxes_outgoing.id', 'faxes_outgoing.fax_data', 'faxes_outgoing.filename', 'faxes_outgoing.outgoing_number_id', 'faxes_outgoing.to')
                .from('faxes_outgoing')
                .innerJoin('iaxfriends', 'iaxfriends.id', 'faxes_outgoing.iaxfriends_id')
                .where('iaxfriends.name', this.serverName)
                .where('state', 'created')
                .then(resolve)
                .catch(reject);
        });
    }
    
    writeFaxPDF(pdfData, filename) {
        return new Promise((resolve, reject) => {
            if (filename.toLowerCase().indexOf('.pdf') == -1) {
                return reject({ msg: 'Only handling .pdf files', error: null });
            }

            let destinationFile = path.join(ASTERISK_SPOOL_FAX_OUT_DIR, filename);

            this.log('Writing PDF file from data', destinationFile);

            fs.writeFile(destinationFile, pdfData, (err) => {
                if (err) return reject({ msg: 'Could not write PDF file', error: err });

                resolve(destinationFile);
            });
        });
    }
    
    removeFaxPDF(pdfFile) {
        return new Promise((resolve, reject) => {
            this.log('Removing PDF file', pdfFile);
            fs.unlink(pdfFile, (err) => {
                if (err) return reject({ msg: 'Could not delete PDF file', error: err });

                resolve();
            });
        });
    }
    
    updateFaxState(id, state) {
        return new Promise((resolve, reject) => {
            this.log('Updating fax state', id, state);

            this.knex.transaction((trx) => {
                trx
                    .where('id', id)
                    .update({
                        state: state
                    })
                    .into('faxes_outgoing')
                    .then(trx.commit)
                    .catch(trx.rollback);
            })
                .then(resolve)
                .catch(reject);
        });
    }
    
    convertPDFToTiff(pdfFile) {
        return new Promise((resolve, reject) => {
            // change .pdf to .tiff (case insensitive) and replace whitespace with _ globally
            let destinationTiffFile = pdfFile.replace(/\.pdf/i, '.tiff').replace(/\s/g, '_');

            this.log('Converting PDF file to TIFF', destinationTiffFile);

            let command = `gs ${GHOSTSCRIPT_ARGUMENTS} -sOutputFile=${destinationTiffFile} ${pdfFile}`;

            this.log('Using command', command);

            // gs - ghostscript converts the .pdf to .tiff 
            exec(command, (err) => {
                if (err) return reject({ msg: 'Could not convert PDF to tiff', error: err });

                resolve(destinationTiffFile);
            });
        });
    }
    
    generateCallFile(outgoingNumberId, faxId, tiffFile, receiver) {
        return new Promise((resolve, reject) => {
            this.knex
                .select('full_number', 'header_ppid', 'ps_endpoints_id')
                .from('trunk_numbers')
                .where('id', outgoingNumberId)
                .where('is_fax', 'yes')
                .then((number) => {
                    if (number.length != 1) {
                        return reject({ msg: 'Could not find outgoing fax number to use', error: null });
                    }

                    let fullNumber = number[0].full_number;
                    let ppidHeader = number[0].header_ppid;
                    let trunk = number[0].ps_endpoints_id;

                    if (ppidHeader) ppidHeader = ppidHeader.replace(/;/g, '\\;');

                    let callfile =
                        `Channel:PJSIP/${receiver}@${trunk}
CallerID:"${fullNumber}"<${fullNumber}>
MaxRetries:4
RetryTime:60
WaitTime:45
Archive:Yes
Context:fax
Extension:out
Priority:1
Set:FAXID=${faxId}
Set:FAXFILE=${tiffFile}
${ppidHeader ? `Set:PJSIP_HEADER(add,P-Preferred-Identity)=${ppidHeader}` : ''}`;

                    let callFilePath = tiffFile.replace(/\.tiff/i, '.call');

                    this.log('Generating callfile', callFilePath);

                    fs.writeFile(callFilePath, callfile, (err) => {
                        if (err) return reject({ msg: 'Could not write callfile', error: err });

                        resolve(callFilePath);
                    });
                })
                .catch(reject);
        });
    }
    
    log(...logItems) {
        if (DEBUG) {
            console.log('Outgoing ->', ...logItems);
        }
    }
}

class FaxProcessor {
    constructor(serverName, knex) {
        this.incomingFaxProcessor = new IncomingFaxProcessor(serverName, knex);
        this.outgoingFaxProcessor = new OutgoingFaxProcessor(serverName, knex);
    }
    
    processAndSendPendingFaxes() {
        return this.outgoingFaxProcessor.processAndSendPendingFaxes();
    }
    
    processAndReceivePendingFaxes() {
        return this.incomingFaxProcessor.processAndReceivePendingFaxes();   
    }
}

module.exports = FaxProcessor;
