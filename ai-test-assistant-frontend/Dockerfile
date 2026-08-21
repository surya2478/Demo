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

ARG REACT_APP_API_URL
ENV REACT_APP_API_URL=$REACT_APP_API_URL

COPY . .

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