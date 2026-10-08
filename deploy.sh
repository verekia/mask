docker buildx build --platform linux/arm64 --load -t verekia/mask .
docker save verekia/mask | gzip > /tmp/mask.tar.gz
scp /tmp/mask.tar.gz midgar:/tmp/
ssh midgar docker load --input /tmp/mask.tar.gz
ssh midgar docker compose up -d mask
