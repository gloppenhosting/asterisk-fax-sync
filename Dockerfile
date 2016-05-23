FROM mhart/alpine-node:5.3.0
MAINTAINER Andreas Krüger
ENV NODE_ENV production
ENV NODE_DEBUG false

USER asterisk

RUN apk add --update nodejs

COPY /server.js /server.js
COPY /package.json /package.json
COPY /faxprocessor.js /faxprocessor.js
COPY /config /config

RUN npm install

CMD ["node", "server.js"]
