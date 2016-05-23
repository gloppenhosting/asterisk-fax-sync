'use strict'

const fs = require('fs');
const path = require('path');
const exec = require('child_process').exec;

class FaxProcessor {
    constructor(serverName, faxDirectoryOut, faxDirectoryIn, knex) {
        this.knex = knex;
        this.serverName = serverName;
        this.faxDirectoryOut = faxDirectoryOut;
        this.faxDirectoryIn = faxDirectoryIn;
    }

    processAndSendPendingFaxes() {
        return new Promise((resolve, reject) => {
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
            fs.rename(callfile, path.join('/var/spool/asterisk/outgoing/', filename), (err) => {
                if (err) {
                    return reject(err);
                }

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
                .then((callFile) => {
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

            let destinationFile = this.faxDirectoryOut + filename;

            fs.writeFile(destinationFile, pdfData, (err) => {
                if (err) {
                    return reject(err);
                }

                resolve(destinationFile);
            });
        });
    }

    updateFaxState(id, state) {
        return new Promise((resolve, reject) => {
            this.knex.transaction(function(trx) {
                    trx
                        .where('id', id)
                        .update({
                            state: state
                        })
                        .into(faxes_outgoing)
                        .then(trx.commit)
                        .catch(trx.rollback);
                })
                .then(resolve)
                .catch(reject);
        });
    }

    convertPDFToTiff(pdfFile) {
        return new Promise((resolve, reject) => {
            let destinationTiffFile = pdfFile.replace(/\.pdf/i, '.tiff');

            exec('gs -q -dNOPAUSE -dBATCH -sDEVICE=tiffg4 -sPAPERSIZE=letter -sOutputFile=' + destinationTiffFile + ' ' + pdfFile, (err) => {
                if (err) {
                    return reject(err);
                }

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

                    console.log('--> Generating callfile');

                    let callfile = `Channel:PJSIP/${receiver}@${trunk}
Callerid:"${fullNumber}"<${fullNumber}>
Maxretries:0
Waittime:45
Context:fax
Extension:out
Priority:1
Set:FAXID=${faxId}
Set:FAXFILE=${tiffFile}
${ppidHeader ? `Set:PJSIP_HEADER(add,P-Preferred-Identity)=${ppidHeader}` : ''}`;

                    let callFilePath = tiffFile.replace('.tiff', '.call');

                    fs.writeFile(callFilePath, callfile, (err) => {
                        if (err) {
                            return reject(err);
                        }

                        resolve(callFilePath);

                    });
                })
                .catch(reject);
        });
    }
}

module.exports = FaxProcessor;
