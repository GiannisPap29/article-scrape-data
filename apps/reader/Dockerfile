FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV PORT=3010
ENV READER_OUTPUT_DIR=/app/data/output

EXPOSE 3010

CMD ["npm", "run", "dev"]
