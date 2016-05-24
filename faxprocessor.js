'use strict'

const fs = require('fs');
const path = require('path');
const exec = require('child_process').exec;
const mkdirp = require('mkdirp');

const GHOSTSCRIPT_ARGUMENTS = process.env.ASTFAX_GS_ARGS || '-q -dNOPAUSE -dBATCH -sDEVICE=tiffg4 -sPAPERSIZE=letter';
const ASTERISK_SPOOL_OUTGOING_DIR = process.env.ASTFAX_SPOOL_OUT_DIR || '/var/spool/asterisk/outgoing/';
const ASTERISK_SPOOL_FAX_IN_DIR = process.env.ASTFAX_FAX_IN_DIR || '/var/spool/asterisk/fax/incoming/';
const ASTERISK_SPOOL_FAX_OUT_DIR = process.env.ASTFAX_FAX_OUT_DIR ||  '/var/spool/asterisk/fax/outgoing/';

class FaxProcessor {
    constructor(serverName, knex) {
        this.knex = knex;
        this.serverName = serverName;
    }

    processAndSendPendingFaxes() {
        return new Promise((resolve, reject) => {
            // make sure required folders exists
            
            mkdirp(ASTERISK_SPOOL_FAX_IN_DIR, (err) => {
                if (err) return reject('Could not create incoming fax directory', err);

                mkdirp(ASTERISK_SPOOL_FAX_OUT_DIR, (err) => {
                    if (err) return reject('Could not create outgoing fax directory', err);

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
        });
    }

    checkOutgoingFaxes() {
        return new Promise((resolve, reject) => {
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

    sendFax(callfile) {
        return new Promise((resolve, reject) => {
            let filename = path.basename(callfile);
            
            fs.rename(callfile, path.join(ASTERISK_SPOOL_OUTGOING_DIR, filename), (err) => {
                if (err) return reject('Could not move callfile to', ASTERISK_SPOOL_OUTGOING_DIR, err);

                resolve();
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

            let callFile = null;

            this.updateFaxState(id, 'processing')
                .then(() => {
                    return this.writeFaxPDF(fax_data, filename);
                })
                .then((pdfFile) => {
                    return this.convertPDFToTiff(pdfFile);
                })
                .then((tiffFile) => {
                    return this.generateCallFile(outgoing_number_id, id, tiffFile, to);
                })
                .then((_callFile) => {
                    callFile = _callFile;

                    return this.updateFaxState(id, 'processed');
                })
                .then(() => {
                    resolve(callFile);
                })
                .catch(reject);
        });
    }

    writeFaxPDF(pdfData, filename) {
        return new Promise((resolve, reject) => {
            if (filename.toLowerCase().indexOf('.pdf') == -1) {
                return reject('Only handling .pdf files');
            }

            let destinationFile = path.join(ASTERISK_SPOOL_FAX_OUT_DIR, filename);

            fs.writeFile(destinationFile, pdfData, (err) => {
                if (err) return reject(err);

                resolve(destinationFile);
            });
        });
    }

    updateFaxState(id, state) {
        return new Promise((resolve, reject) => {
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

            // gs - ghostscript converts the .pdf to .tiff 
            exec(`gs ${GHOSTSCRIPT_ARGUMENTS} -sOutputFile=${destinationTiffFile} ${pdfFile}`, (err) => {
                if (err) return reject('Could not convert PDF to tiff', err);

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
                        return reject('Could not find outgoing fax number to use');
                    }

                    let fullNumber = number[0].full_number;
                    let ppidHeader = number[0].header_ppid;
                    let trunk = number[0].ps_endpoints_id;

                    if (ppidHeader) ppidHeader = ppidHeader.replace(/;/g, '\\;');

                    console.log('--> Generating callfile');

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

                    fs.writeFile(callFilePath, callfile, (err) => {
                        if (err) return reject('Could not write callfile', err);

                        resolve(callFilePath);
                    });
                })
                .catch(reject);
        });
    }
}

module.exports = FaxProcessor;
