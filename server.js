const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static("public"));

// Game configuration
const GRID_SIZE = 500;
const CELL_SIZE = 10;
const GAME_TICK_RATE = 100; // Milliseconds per game update (constant tick rate)
const MIN_PLAYERS = 2;

// Game state
const snakes = {};
let gamePaused = false;
let gameInProgress = false;
let waitingPlayers = {};
let gameLoopInterval = null;

// Food configuration
const foodConfig = {
  golden: { count: 3, effect: "grow" },      // Yellow pellet - growth
  green: { count: 3, effect: "speedShrink" }, // Green - speed+shrink
  red: { count: 2, effect: "life" },         // Heart - extra life
  white: { count: 2, effect: "bullet" },     // Bullet
  venom: { count: 2, effect: "venom" }       // Venom
};

// Initialize food storage
const food = {
  golden: [],
  green: [],
  red: [],
  white: [],
  venom: []
};

// Portal system
let portals = [];

const availableColors = ["blue", "purple", "orange", "pink", "cyan", "magenta", "lime", "indigo"];
const directions = { 
  up: { x: 0, y: -CELL_SIZE }, 
  down: { x: 0, y: CELL_SIZE }, 
  left: { x: -CELL_SIZE, y: 0 }, 
  right: { x: CELL_SIZE, y: 0 } 
};

// Movement timing control
const baseSpeed = GAME_TICK_RATE; // Match to tick rate

// Utility functions
function getRandomPosition() {
  // Ensure positions are aligned to grid
  const maxPos = GRID_SIZE / CELL_SIZE;
  return { 
    x: Math.floor(Math.random() * maxPos) * CELL_SIZE, 
    y: Math.floor(Math.random() * maxPos) * CELL_SIZE 
  };
}

// Get a position away from existing snakes
function getSafeSnakePosition() {
  let position;
  let isSafe = false;
  let attempts = 0;
  
  while (!isSafe && attempts < 50) {
    position = getRandomPosition();
    isSafe = true;
    
    // Check distance from all existing snake positions
    Object.values(snakes).forEach(snake => {
      if (snake.body && snake.body.length > 0) {
        const dx = Math.abs(position.x - snake.body[0].x);
        const dy = Math.abs(position.y - snake.body[0].y);
        if (dx < CELL_SIZE * 5 && dy < CELL_SIZE * 5) {
          isSafe = false;
        }
      }
    });
    
    attempts++;
  }
  
  return position;
}

function generatePortals() {
  portals = [];
  let portal1 = getRandomPosition();
  let portal2;
  
  // Ensure portals are adequately separated
  do {
    portal2 = getRandomPosition();
  } while (
    Math.abs(portal1.x - portal2.x) < GRID_SIZE / 3 && 
    Math.abs(portal1.y - portal2.y) < GRID_SIZE / 3
  );
  
  portals.push(portal1, portal2);
  io.emit("updatePortals", portals);
}

function generateFood() {
  // Generate each type of food
  Object.keys(foodConfig).forEach(type => {
    while (food[type].length < foodConfig[type].count) {
      const position = getRandomPosition();
      
      // Check if position is not occupied by any existing game element
      const isOccupied = (
        portals.some(portal => portal.x === position.x && portal.y === position.y) ||
        Object.values(food).flat().some(f => f.x === position.x && f.y === position.y) ||
        Object.values(snakes).some(snake => 
          snake.body && snake.body.some(segment => 
            segment.x === position.x && segment.y === position.y
          )
        )
      );
      
      if (!isOccupied) {
        food[type].push(position);
      }
    }
  });
  
  io.emit("updateFood", food);
}

function resetGame() {
  // Clear all game data
  Object.keys(snakes).forEach(id => delete snakes[id]);
  
  // Reset food
  Object.keys(food).forEach(type => {
    food[type] = [];
  });
  
  // Generate new game elements
  generatePortals();
  
  gamePaused = false;
  gameInProgress = false;
  
  // Move waiting players to active game
  Object.keys(waitingPlayers).forEach(id => {
    if (waitingPlayers[id].readyToPlay) {
      // Create snake starting with 3 segments
      const startPos = getSafeSnakePosition();
      const initialBody = [
        { ...startPos },
        { x: startPos.x - CELL_SIZE, y: startPos.y },
        { x: startPos.x - CELL_SIZE * 2, y: startPos.y }
      ];
      
      snakes[id] = {
        color: waitingPlayers[id].color,
        body: initialBody,
        direction: "right",
        speed: baseSpeed,
        active: true,
        lastDirection: "right",
        lives: 1, // Start with 1 lives
        hasBullet: false,
        firingBullet: false,
        bulletPosition: null,
        bulletDirection: null,
        hasVenom: false,
        venomEndTime: 0,
        venomBullet: false,
        lastMoveTime: Date.now() // Track last move time
      };
    }
  });
  
  waitingPlayers = {};
  
  // Start the game if we have enough players
  if (Object.keys(snakes).length >= MIN_PLAYERS) {
    gameInProgress = true;
    generateFood(); // Initial food generation
    io.emit("gameStarted");
    
    // Clear any existing game loop
    if (gameLoopInterval) {
      clearInterval(gameLoopInterval);
    }
    
    // Start game loop with fixed interval for consistent gameplay
    gameLoopInterval = setInterval(gameLoop, GAME_TICK_RATE);
  }
  
  // Send updated state to all clients
  io.emit("updatePlayers", formatSnakesForClient());
  io.emit("waitingPlayersUpdate", getWaitingPlayersInfo());
  io.emit("availableColorsUpdate", getAvailableColors());
  io.emit("gridSizeUpdate", GRID_SIZE);
}

// Format snake data for client to reduce payload size
function formatSnakesForClient() {
  const formattedSnakes = {};
  
  Object.keys(snakes).forEach(id => {
    const snake = snakes[id];
    if (snake.active) {
      formattedSnakes[id] = {
        color: snake.color,
        body: snake.body,
        direction: snake.direction,
        active: snake.active,
        lives: snake.lives,
        hasBullet: snake.hasBullet,
        firingBullet: snake.firingBullet,
        bulletPosition: snake.bulletPosition,
        hasVenom: snake.hasVenom,
        venomBullet: snake.venomBullet
      };
    }
  });
  
  return formattedSnakes;
}

function getWaitingPlayersInfo() {
  const info = {};
  Object.keys(waitingPlayers).forEach(id => {
    info[id] = {
      color: waitingPlayers[id].color,
      readyToPlay: waitingPlayers[id].readyToPlay
    };
  });
  return info;
}

function getAvailableColors() {
  const selectedColors = [
    ...Object.values(waitingPlayers).map(player => player.color),
    ...Object.values(snakes).filter(snake => snake.active).map(snake => snake.color)
  ];
  
  return availableColors.filter(color => !selectedColors.includes(color));
}

function areAllPlayersReady() {
  const totalPlayers = Object.keys(waitingPlayers).length;
  if (totalPlayers < MIN_PLAYERS) return false;
  
  const readyPlayers = Object.values(waitingPlayers).filter(player => player.readyToPlay).length;
  return readyPlayers === totalPlayers;
}

function checkPortalTransport(position) {
  if (portals.length !== 2) return null;
  
  // Check if position precisely matches a portal location
  for (let i = 0; i < portals.length; i++) {
    if (position.x === portals[i].x && position.y === portals[i].y) {
      const otherPortalIndex = (i + 1) % 2;
      return { x: portals[otherPortalIndex].x, y: portals[otherPortalIndex].y };
    }
  }
  
  return null;
}

// Initialize the game
generatePortals();

io.on("connection", (socket) => {
  console.log("New player connected:", socket.id);
  
  // Send current game state to the new player
  socket.emit("gameState", {
    inProgress: gameInProgress,
    waitingPlayers: getWaitingPlayersInfo(),
    gridSize: GRID_SIZE
  });
  
  socket.emit("availableColorsUpdate", getAvailableColors());
  socket.emit("updatePortals", portals);
  socket.emit("updateFood", food);
  socket.emit("updatePlayers", formatSnakesForClient());
  
  // Handle color selection
  socket.on("selectColor", (color) => {
    if (!gameInProgress && availableColors.includes(color) && 
        !Object.values(waitingPlayers).some(player => player.color === color)) {
      
      waitingPlayers[socket.id] = {
        color: color,
        readyToPlay: false
      };
      
      // Broadcast updates
      io.emit("waitingPlayersUpdate", getWaitingPlayersInfo());
      io.emit("availableColorsUpdate", getAvailableColors());
    }
  });
  
  // Handle ready state
  socket.on("readyToPlay", () => {
    if (waitingPlayers[socket.id]) {
      waitingPlayers[socket.id].readyToPlay = true;
      io.emit("waitingPlayersUpdate", getWaitingPlayersInfo());
      
      if (areAllPlayersReady() && !gameInProgress) {
        resetGame();
      }
    }
  });
  
  // Handle restart request
  socket.on("restartGame", () => {
    if (socket.id in snakes || socket.id in waitingPlayers) {
      // Move players back to waiting room
      Object.keys(snakes).forEach(id => {
        if (snakes[id].active) {
          waitingPlayers[id] = {
            color: snakes[id].color,
            readyToPlay: false
          };
        }
      });
      
      io.emit("waitingPlayersUpdate", getWaitingPlayersInfo());
      io.emit("availableColorsUpdate", getAvailableColors());
      io.emit("returnToLobby");
      
      if (gameLoopInterval) {
        clearInterval(gameLoopInterval);
        gameLoopInterval = null;
      }
      
      gameInProgress = false;
    }
  });
  
  socket.on("move", ({ direction }) => {
    if (directions[direction] && snakes[socket.id] && snakes[socket.id].active) {
      // Prevent 180-degree turns
      const opposite = {
        up: "down", down: "up", left: "right", right: "left"
      };
      
      if (direction !== opposite[snakes[socket.id].lastDirection]) {
        snakes[socket.id].direction = direction;
      }
    }
  });
  
socket.on("fire", () => {
  const snake = snakes[socket.id];
  if (snake && snake.active && snake.hasBullet && !snake.firingBullet) {
    snake.firingBullet = true;
    snake.hasBullet = false;
    
    // Calculate bullet position in front of the snake head
    const head = snake.body[0];
    const bulletOffset = directions[snake.direction];
    
    snake.bulletPosition = { 
      x: head.x + bulletOffset.x,
      y: head.y + bulletOffset.y
    };
    
    snake.bulletDirection = snake.direction;
    
    // Set venom bullet status
    snake.venomBullet = snake.hasVenom;
    
    // Broadcast bullet firing immediately
    io.emit("updatePlayers", formatSnakesForClient());
  }
});
  
  socket.on("disconnect", () => {
    // Handle player disconnection
    console.log("Player disconnected:", socket.id);
    
    if (waitingPlayers[socket.id]) {
      delete waitingPlayers[socket.id];
      io.emit("waitingPlayersUpdate", getWaitingPlayersInfo());
      io.emit("availableColorsUpdate", getAvailableColors());
    }
    
    if (snakes[socket.id]) {
      // Mark snake as inactive instead of deleting
      snakes[socket.id].active = false;
      io.emit("updatePlayers", formatSnakesForClient());
      
      // Check if game should end
      checkGameEnd();
    }
  });
});

// Bulleft functions without edge wrapping
function moveBullets() {
  let bulletUpdates = false;
  
  Object.keys(snakes).forEach(id => {
    let snake = snakes[id];
    
    if (snake.firingBullet && snake.bulletPosition) {
      // Move the bullet (now at normal speed for both regular and venom bullets)
      snake.bulletPosition.x += directions[snake.bulletDirection].x;
      snake.bulletPosition.y += directions[snake.bulletDirection].y;
      
      // Check if bullet went through a portal
      const portalExit = checkPortalTransport(snake.bulletPosition);
      if (portalExit) {
        snake.bulletPosition = { ...portalExit };
      }
      
      // Check if bullet hit the edge (NO MORE WRAPPING)
      if (
        snake.bulletPosition.x < 0 || 
        snake.bulletPosition.x >= GRID_SIZE || 
        snake.bulletPosition.y < 0 || 
        snake.bulletPosition.y >= GRID_SIZE
      ) {
        snake.firingBullet = false;
        snake.bulletPosition = null;
        snake.venomBullet = false;
        bulletUpdates = true;
        return;
      }
      
      // Check collision with other snakes
      let hitSnake = false;
      let hitSnakeId = null;
      
      Object.keys(snakes).forEach(otherId => {
        if (id !== otherId && snakes[otherId].active) {
          // Check if bullet hit any segment
          const hitSegment = snakes[otherId].body.some(segment => 
            segment.x === snake.bulletPosition.x && segment.y === snake.bulletPosition.y
          );
          
          if (hitSegment) {
            hitSnake = true;
            hitSnakeId = otherId;
          }
        }
      });
      
      // Handle hit
      if (hitSnake && hitSnakeId) {
        if (snake.venomBullet) {
          // Venom bullet instantly eliminates the snake
          snakes[hitSnakeId].active = false;
        } else {
          // Regular bullet takes one life
          if (snakes[hitSnakeId].lives > 1) {
            snakes[hitSnakeId].lives--;
          } else {
            snakes[hitSnakeId].active = false;
          }
        }
        bulletUpdates = true;
      }
      
      // Remove bullet if it hit a snake or traveled too far (prevent infinite bullets)
      const MAX_BULLET_DISTANCE = 50;
      const head = snake.body[0];
      const distanceX = Math.abs(snake.bulletPosition.x - head.x);
      const distanceY = Math.abs(snake.bulletPosition.y - head.y);
      
      if (hitSnake || distanceX > CELL_SIZE * MAX_BULLET_DISTANCE || distanceY > CELL_SIZE * MAX_BULLET_DISTANCE) {
        snake.firingBullet = false;
        snake.bulletPosition = null;
        snake.venomBullet = false;
        bulletUpdates = true;
      } else {
        bulletUpdates = true;
      }
    }
  });
  
  return bulletUpdates;
}

function updateVenomStatus() {
  let venomUpdates = false;
  const currentTime = Date.now();
  
  Object.keys(snakes).forEach(id => {
    const snake = snakes[id];
    if (snake.hasVenom && currentTime > snake.venomEndTime) {
      snake.hasVenom = false;
      venomUpdates = true;
    }
  });
  
  return venomUpdates;
}

function processSnakeCollisions(id, newHead) {
  const snake = snakes[id];
  let collision = false;
  let collidedWithVenomSnake = false;
  let selfCollision = false;
  
  // Check for collision with self (skip the tail since it's moving)
  for (let i = 1; i < snake.body.length - 1; i++) {
    if (newHead.x === snake.body[i].x && newHead.y === snake.body[i].y) {
      collision = true;
      selfCollision = true;
      break;
    }
  }
  
  // Check for collision with other snakes
if (!collision) {
  Object.keys(snakes).forEach(otherId => {
    if (id !== otherId && snakes[otherId].active) {
      for (let i = 0; i < snakes[otherId].body.length; i++) {
        const segment = snakes[otherId].body[i];
        if (newHead.x === segment.x && newHead.y === segment.y) {
          collision = true;
          
          // Venom logic - this is the key change
          if (snakes[otherId].hasVenom) {
            collidedWithVenomSnake = true;
          } else if (snake.hasVenom) {
            // This snake has venom and collided with another snake
            // The other snake should take damage
            if (snakes[otherId].lives > 1) {
              snakes[otherId].lives--;
            } else {
              snakes[otherId].active = false;
            }
            collision = false; // This snake survives the collision
          }
          break;
        }
      }
    }
  });
}
  
  // Handle collision
  if (collision) {
    if (selfCollision || collidedWithVenomSnake) {
      if (snake.lives > 1) {
        snake.lives--;
      } else {
        snake.active = false;
      }
    } else {
      // Regular collision with other snake
      if (snake.lives > 1) {
        snake.lives--;
      } else {
        snake.active = false;
      }
    }
  }
  
  return { collision };
}

function handleFoodCollision(id, newHead) {
  const snake = snakes[id];
  let growthApplied = false;
  let foodUpdates = false;
  
  // Check each food type for collision
  Object.keys(food).forEach(type => {
    const foodIndex = food[type].findIndex(f => f.x === newHead.x && f.y === newHead.y);
    
    if (foodIndex !== -1) {
      // Remove the food
      food[type].splice(foodIndex, 1);
      foodUpdates = true;
      
      // Apply effect based on food type
      switch (type) {
        case "golden": // Growth
          for (let i = 0; i < 5; i++) {
            snake.body.push({ ...snake.body[snake.body.length - 1] });
          }
          growthApplied = true;
          break;
          
        case "green": // Speed + Shrink
          // Trim to head + 2 segments
          snake.body = snake.body.slice(0, Math.min(3, snake.body.length));
          
          // Apply speed boost
          snake.speed = Math.floor(baseSpeed / 4); // 4x faster
          setTimeout(() => { 
            if (snake && snake.active) snake.speed = baseSpeed; 
          }, 5000);
          
          growthApplied = true;
          break;
          
        case "red": // Extra life (up to maximum of 5)
          snake.lives = Math.min(5, snake.lives + 1);
          break;
          
        case "white": // Bullet
          snake.hasBullet = true;
          break;
          
        case "venom": // Venom power
          snake.hasVenom = true;
          snake.venomEndTime = Date.now() + 15000; // 15 seconds
          break;
      }
    }
  });
  
  return { growthApplied, foodUpdates };
}

function checkGameEnd() {
  // Count active snakes
  let activeSnakes = Object.values(snakes).filter(s => s.active);
  
  // Check for a winner
  if (activeSnakes.length === 1 && Object.keys(snakes).length > 1) {
    gamePaused = true;
    gameInProgress = false;
    
    if (gameLoopInterval) {
      clearInterval(gameLoopInterval);
      gameLoopInterval = null;
    }
    
    io.emit("gameOver", { winner: activeSnakes[0].color });
    return true;
  } else if (activeSnakes.length === 0 && Object.keys(snakes).length > 0) {
    gamePaused = true;
    gameInProgress = false;
    
    if (gameLoopInterval) {
      clearInterval(gameLoopInterval);
      gameLoopInterval = null;
    }
    
    io.emit("gameOver", { winner: "No" });
    return true;
  }
  
  return false;
}

function gameLoop() {
  if (gamePaused || !gameInProgress) return;

  let stateUpdated = false;
  
  // Process bullet movements
  const bulletUpdates = moveBullets();
  if (bulletUpdates) stateUpdated = true;
  
  // Update venom status
  const venomUpdates = updateVenomStatus();
  if (venomUpdates) stateUpdated = true;

  // Process snake movements
  const currentTime = Date.now();
  Object.keys(snakes).forEach(id => {
    let snake = snakes[id];
    if (!snake.active) return;

    // Only move snake if it's time based on its speed
    if (currentTime - snake.lastMoveTime >= snake.speed) {
      snake.lastMoveTime = currentTime;
      
      // Calculate new head position
      let newHead = { 
        x: snake.body[0].x + directions[snake.direction].x, 
        y: snake.body[0].y + directions[snake.direction].y 
      };
      
      // Portal transportation
      const portalExit = checkPortalTransport(newHead);
      if (portalExit) {
        newHead = { ...portalExit };
      } else {
        // Infinite Wrapping
        newHead.x = (newHead.x + GRID_SIZE) % GRID_SIZE;
        newHead.y = (newHead.y + GRID_SIZE) % GRID_SIZE;
      }
      
      // Process collisions with other snakes
      const { collision } = processSnakeCollisions(id, newHead);
      if (!snake.active) return; // Snake may have died in collision
      
      // Add new head
      snake.body.unshift(newHead);
      snake.lastDirection = snake.direction;
      
      // Handle food collisions
      const { growthApplied, foodUpdates } = handleFoodCollision(id, newHead);
      if (foodUpdates) {
        stateUpdated = true;
        // Replenish food
        generateFood();
      }
      
      // Remove tail segment if no growth occurred
      if (!growthApplied) {
        snake.body.pop();
      }
      
      stateUpdated = true;
    }
  });
  
  // Check for game end condition
  if (checkGameEnd()) {
    return;
  }
  
  // Only send updates if state has changed
  if (stateUpdated) {
    io.emit("updatePlayers", formatSnakesForClient());
  }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Snake game server running on port ${PORT}`);
});
