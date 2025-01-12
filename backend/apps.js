import { createServer } from 'http';
import { Server } from 'socket.io';
import msgpackParser from 'socket.io-msgpack-parser';
import path from 'path';


import { config } from 'dotenv';
config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

var drawings = [];
var undos = [];
var moves = [];
var zooms = [];
var copies = [];

setInterval(async () => {
  const promises = [];
  if (drawings.length > 0) {
    const data = drawings;
    
    drawings = [];
    
    promises.push(prisma.drawing.createMany({
      data,
      skipDuplicates: true,
    }));
  }

  if (undos.length > 0) {
    
    drawings = drawings.filter((drawing) => !undos.includes(drawing.strokeId));
    
    const strokeIds = undos;
    
    undos = [];
    promises.push(prisma.drawing.deleteMany({
      where: {
        strokeId: { in: strokeIds }
      }
    }));
  }

  if (moves.length > 0) {
    const movements = moves;
    moves = [];

    for (const { strokeIds, delta: { x, y } } of movements) {
      promises.push(prisma.drawing.updateMany({
        where: { strokeId: { in: strokeIds } },
        data: {
          beginPointX: { increment: x },
          beginPointY: { increment: y },
          ctrlPointX: { increment: x },
          ctrlPointY: { increment: y },
          endPointX: { increment: x },
          endPointY: { increment: y },
        }
      }));
    }
  }

  if (zooms.length > 0) {
    const zoomList = zooms;
    zooms = [];

    for (const { strokeIds, scale, delta: { x, y } } of zoomList) {
      const scaled = prisma.drawing.updateMany({
        where: { strokeId: { in: strokeIds } },
        data: {
          beginPointX: { multiply: scale },
          beginPointY: { multiply: scale },
          ctrlPointX: { multiply: scale },
          ctrlPointY: { multiply: scale },
          endPointX: { multiply: scale },
          endPointY: { multiply: scale },
        }
      });
      const processDelta = prisma.drawing.updateMany({
        where: { strokeId: { in: strokeIds } },
        data: {
          beginPointX: { decrement: x },
          beginPointY: { decrement: y },
          ctrlPointX: { decrement: x },
          ctrlPointY: { decrement: y },
          endPointX: { decrement: x },
          endPointY: { decrement: y },
        }
      });
      promises.push(prisma.$transaction([scaled, processDelta]));
    }
  }

  if (promises.length > 0) {
    await Promise.all(promises);
  }
}, 5);

setInterval(async () => {
  if (copies.length > 0) {
    const copyList = copies;
    copies = [];

    const srcStrokeIds = [];
    copyList.forEach(({ strokeIds }) => srcStrokeIds.push(...strokeIds));

    const srcDrawings = await prisma.drawing.findMany({
      where: { strokeId: { in: srcStrokeIds } },
      orderBy: [{ id: 'asc' }],
    });

    const promises = [];
    for (const { strokeIds, newStrokeIds } of copyList) {
      const bulk = [];
      for (let i = 0; i < strokeIds.length; i++) {
        const strokeId = strokeIds[i];
        const newStrokeId = newStrokeIds[i];
        for (const drawing of srcDrawings) {
          if (drawing.strokeId === strokeId) {
            const dstDrawing = { ...drawing };
            delete dstDrawing.id;
            dstDrawing.strokeId = newStrokeId;
            bulk.push(dstDrawing);
          }
        }
      }
      if (bulk.length > 0) {
        promises.push(prisma.drawing.createMany({
          data: bulk,
          skipDuplicates: true,
        }));
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }
}, 5);

 
const httpServer = createServer();

// basePath must start with '/'
const basePath = process.env.BASE_PATH || '/';
const origin = process.env.ALLOW_ORIGIN || '*';

const io = new Server(httpServer, {
  perMessageDeflate: true,
  parser: msgpackParser,
  serveClient: false,
  path: path.join(basePath, 'socket.io'),
  cors: { origin }
});


io.on('connection', async (socket) => {
  console.log(socket.id, 'connected');

  socket
    
    .on('drawing', (drawing) => {
      
      socket.broadcast.emit('drawing', drawing);
      
      if (!drawing.end) {
        const { strokeId, pen, beginPoint, controlPoint, endPoint } = drawing;
        const { color, opacity, size } = pen;
        drawings.push({
          strokeId,
          color,
          opacity,
          size,
          beginPointX: beginPoint.x,
          beginPointY: beginPoint.y,
          ctrlPointX: controlPoint.x,
          ctrlPointY: controlPoint.y,
          endPointX: endPoint.x,
          endPointY: endPoint.y,
        });
      }
    })
    
    .on('undo', (stroke) => {
    
      socket.broadcast.emit('undo', stroke);
      
      undos.push(stroke.id);
    })
  
    .on('delete', (strokes) => {

      socket.broadcast.emit('delete', strokes);
    
      undos.push(...strokes.ids);
    })
    
    .on('move', (movement) => {
      
      socket.broadcast.emit('move', movement);
      
      moves.push(movement);
    })

    .on('copy', (copy) => {

      socket.broadcast.emit('copy', copy);
      
      copies.push(copy);
    })
    
    .on('zoom', (zoom) => {
      
      socket.broadcast.emit('zoom', zoom);
      zooms.push(zoom);
    })
    
    .on('disconnect', () => {
      console.log(socket.id, 'disconnect');
    });

  
  const t = new Date().getTime();

  
  const ds = await prisma.drawing.findMany({ orderBy: [{ id: 'asc' }] });
  console.log(socket.id, 'load drawings cost', new Date().getTime() - t, 'ms');

  const strokes = [];
  let stroke;
  for (const { strokeId, color, opacity, size, beginPointX, beginPointY, ctrlPointX, ctrlPointY, endPointX, endPointY } of ds) {
    if (!stroke) {
      stroke = { id: strokeId, color, opacity, size, drawings: [] };
      strokes.push(stroke);
    } else if (stroke.id !== strokeId) {
      stroke = strokes.find(s => s.id === strokeId);
      if (!stroke) {
        stroke = { id: strokeId, color, opacity, size, drawings: [] };
        strokes.push(stroke);
      }
    }
    stroke.drawings.push({
      bp: { x: beginPointX, y: beginPointY },
      cp: { x: ctrlPointX, y: ctrlPointY },
      ep: { x: endPointX, y: endPointY },
    });
  }
  socket.emit(
    'strokes',
    strokes,
    () => console.log(socket.id, 'sync strokes cost', new Date().getTime() - t, 'ms')
  );
});

const port = process.env.PORT || 5000;
const host = process.env.HOST || 'localhost';
httpServer.listen(port, host, () => {
  console.log(`server listen on ${host}:${port}`);
});
