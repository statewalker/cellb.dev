<?php
// Every request goes through this router (php -S ... index.php).
header("content-type: application/json");
echo json_encode([
    "php" => PHP_VERSION,
    "uri" => $_SERVER["REQUEST_URI"],
    "cell" => getenv("CELL") ?: null,
]);
