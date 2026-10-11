// Pong — built with raylib. Press W/S (left paddle), Up/Down (right paddle).
#include <raylib.h>
#include <algorithm>

int main(void)
{
    const int W = 1024, H = 600;
    InitWindow(W, H, "Pong — FullIDE");
    SetTargetFPS(60);

    Rectangle ball   = { W / 2.0f - 8, H / 2.0f - 8, 16, 16 };
    Rectangle left   = { 40.0f, H / 2.0f - 60, 14, 120 };
    Rectangle right  = { W - 54.0f, H / 2.0f - 60, 14, 120 };
    float vx = 420.0f, vy = 260.0f;
    int scoreL = 0, scoreR = 0;

    while (!WindowShouldClose()) {
            

        if (IsKeyDown(KEY_W)) left.y  -= 560.0f * dt;
        if (IsKeyDown(KEY_S)) left.y  += 560.0f * dt;
        if (IsKeyDown(KEY_UP))    right.y -= 560.0f * dt;
        if (IsKeyDown(KEY_DOWN))  right.y += 560.0f * dt;
        left.y  = std::clamp(left.y,  0.0f, H - left.height);
        right.y = std::clamp(right.y, 0.0f, H - right.height);

        ball.x += vx * dt;
        ball.y += vy * dt;
        if (ball.y <= 0)             { ball.y = 0; vy = -vy; }
        if (ball.y >= H - ball.height) { ball.y = H - ball.height; vy = -vy; }

        if (CheckCollisionRecs(ball, left)  && vx < 0) { vx = -vx * 1.05f; ball.x = left.x + left.width; }
        if (CheckCollisionRecs(ball, right) && vx > 0) { vx = -vx * 1.05f; ball.x = right.x - ball.width; }

        if (ball.x < -20) { scoreR++; ball = (Rectangle){ W/2.0f, H/2.0f, 16, 16 }; vx = 420.0f; vy = (float)GetRandomValue(-260, 260); }
        if (ball.x > W + 20) { scoreL++; ball = (Rectangle){ W/2.0f, H/2.0f, 16, 16 }; vx = -420.0f; vy = (float)GetRandomValue(-260, 260); }

        BeginDrawing();
        ClearBackground(RAYWHITE);
        DrawRectangle(0, 0, W, H, (Color){ 24, 26, 33, 255 });
        DrawLineEx((Vector2){ W/2.0f, 0 }, (Vector2){ W/2.0f, H }, 4, (Color){ 90, 94, 110, 255 });
        DrawRectangleRec(left,  (Color){ 97, 175, 239, 255 });
        DrawRectangleRec(right, (Color){ 224, 108, 117, 255 });
        DrawRectangleRec(ball,  (Color){ 152, 195, 121, 255 });
        DrawText(TextFormat("%d", scoreL), W/2 - 60, 24, 40, LIGHTGRAY);
        DrawText(TextFormat("%d", scoreR), W/2 + 40, 24, 40, LIGHTGRAY);
        DrawText("W/S : Up/Down", 12, H - 30, 16, (Color){ 120, 124, 140, 255 });
        EndDrawing();
    }

    CloseWindow();
    return 0;
}
