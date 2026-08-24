# Stage 1: Build the React app
FROM node:20 AS builder

WORKDIR /app

# Define ARG variables for proxy settings
ARG HTTP_PROXY
ARG HTTPS_PROXY

# Set them as ENV variables so npm and other tools can use them
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV NODE_ENV development

COPY package.json package-lock.json ./
RUN npm install

# --- Automation Module: the API base is a build input, not a leftover ---------
# REACT_APP_API_URL below is inert: this is a Vite app, and Vite only exposes
# variables prefixed VITE_ to import.meta.env. It is kept so existing build
# commands that pass it do not break, but it has never reached the bundle.
#
# VITE_API_URL is the one that matters. src/config/ai-api.ts reads it through
# import.meta.env and Vite INLINES it into the JavaScript at build time, so the
# value chosen here is frozen into the image -- the VITE_API_URL that
# docker-compose.yml sets in `environment:` arrives far too late to matter, as
# nginx by then is serving a static bundle that already has a URL compiled in.
#
# Getting it wrong is not subtle: `.env` in this directory carries a developer's
# http://127.0.0.1:8002, and a bundle built with that sends every enterprise
# user's browser to their own machine.
#
# .env.production is written rather than .env edited, because Vite loads the
# mode-specific file last and `vite build` runs in production mode -- so this
# wins over the committed .env without modifying it, and every other VITE_ key
# in that file still applies.
#
#   docker build --build-arg VITE_API_URL=https://host/admin/ -t frontend .
ARG REACT_APP_API_URL
ENV REACT_APP_API_URL=$REACT_APP_API_URL

ARG VITE_API_URL

COPY . .

RUN set -eu;     if [ -z "${VITE_API_URL:-}" ]; then         echo "ERROR: VITE_API_URL build arg is required.";         echo "It is compiled into the bundle and cannot be changed afterwards.";         exit 1;     fi;     echo "VITE_API_URL=${VITE_API_URL}" > .env.production;     echo "Building bundle against API base: ${VITE_API_URL}"

RUN npm run build

# Stage 2: Serve with Nginx
# FROM nginx:stable-alpine

# # Remove default Nginx page
# RUN rm -rf /usr/share/nginx/html/*

# # Copy built files
# COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom Nginx config (optional)
# COPY nginx.conf /etc/nginx/nginx.conf

# COPY nginx.conf /etc/nginx/conf.d/default.conf


# EXPOSE 5173

# CMD ["npm", "run", "dev", "--", "--port", "5173"]

# Stage 2: Serve with Nginx
FROM nginx:stable-alpine

# Remove default Nginx page
RUN rm -rf /usr/share/nginx/html/*

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom Nginx config (optional)
# COPY nginx.conf /etc/nginx/nginx.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf


EXPOSE 5173

CMD ["nginx", "-g", "daemon off;"]