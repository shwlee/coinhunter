using System.Collections.Generic;

// C1 analysis fixture; C# execution is not enabled in the game yet.
public class Player
{
    int columns;
    public void Initialize(int myNumber, int column, int row)
    {
        columns = column;
    }
    public string GetName()
    {
        return "가까운 코인";
    }
    public int MoveNext(int[] map, int myPosition, int[] items)
    {
        bool[] visited = new bool[map.Length];
        int[] first = new int[map.Length];
        int[] offsets = new int[] { -1, -columns, 1, columns };
        var queue = new Queue<int>();
        queue.Enqueue(myPosition);
        visited[myPosition] = true;
        first[myPosition] = -1;
        while (queue.Count > 0)
        {
            int current = queue.Dequeue();
            if (current != myPosition && map[current] > 0) return first[current];
            for (int direction = 0; direction < 4; direction++)
            {
                if (direction == 0 && current % columns == 0) continue;
                if (direction == 2 && current % columns == columns - 1) continue;
                int next = current + offsets[direction];
                if (next < 0 || next >= map.Length || visited[next] || map[next] == -1) continue;
                visited[next] = true;
                first[next] = current == myPosition ? direction : first[current];
                queue.Enqueue(next);
            }
        }
        return -1;
    }
}
