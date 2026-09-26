FROM node:22-slim

# Install python3 without pinning to a specific version
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user/group with no shell
RUN groupadd -g 10001 sandbox && \
    useradd -u 10001 -g sandbox -s /sbin/nologin -M sandbox

WORKDIR /sandbox

# The container is started with a sleep so that putArchive can write into /sandbox
# after the tmpfs is mounted and the container is running.
CMD ["sh", "-c", "sleep 3600"]
