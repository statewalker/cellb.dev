FROM php:8.3-cli
COPY www /workspace/www
EXPOSE 8080
CMD ["php", "-S", "0.0.0.0:8080", "-t", "/workspace/www", "/workspace/www/index.php"]
